// 푸시 알림(APNs) — 이 파일만 애플을 안다.
//
// mailer.ts 가 메일 provider 를 혼자 아는 것과 같은 구조다. 호출부는 "누구에게 무엇을 알린다"만
// 알고, 토큰 관리·JWT 서명·게이트웨이 선택·죽은 토큰 정리는 전부 여기 있다.
//
// ── 왜 라이브러리를 쓰지 않나
//  APNs 는 HTTP/2 + ES256 JWT 두 가지만 요구하고, 둘 다 Node 내장으로 된다(node:http2 가
//  HTTP/2 를, crypto 가 ES256 서명을 한다). 인증 토큰은 최대 1시간 유효해 캐시하면 요청마다
//  서명할 일도 없다. 의존성을 늘리는 대신 100줄을 직접 두는 편이 낫다고 봤다.
//
// ⚠️ **fetch() 로는 APNs 에 못 보낸다.** api.push.apple.com 은 HTTP/2 만 말하는데 Node 의 전역
//    fetch 는 HTTP/1.1 로 붙어서 `TypeError: fetch failed`(HTTPParserError) 로 끝난다. 응답조차
//    못 받으니 조용히 실패한다. 그래서 node:http2 를 직접 쓴다.
//
// ⚠️ **환경(sandbox/production)을 토큰마다 따른다.** TestFlight·앱스토어 빌드는 production,
//    Xcode 로 꽂은 빌드는 sandbox 이고, 반대쪽 게이트웨이로 보내면 BadDeviceToken 으로
//    **조용히** 실패한다. 그래서 device_tokens.environment 를 not null 로 두었다(044).
//
// ⚠️ **뱃지(aps.badge)를 넣지 않는다.** 서버가 "안 읽은 수" 를 모르는 동안 0 을 보내면 뱃지가
//    지워지고, 임의의 수를 보내면 실제와 어긋난다. 알림 목록 API 가 생기면 그때 넣는다.
import { createSign } from 'node:crypto';
import http2 from 'node:http2';
import { config } from '../config';
import { query } from '../db';

const GATEWAY = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
} as const;

type Env = keyof typeof GATEWAY;

/** APNs 인증 토큰. 최대 1시간 유효 — 55분에 갱신해 경계에서 만료되지 않게 한다. */
let cachedJwt: { token: string; at: number } | null = null;
const JWT_TTL_MS = 55 * 60 * 1000;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** ES256 으로 서명한 provider 토큰을 만든다(애플이 요구하는 형식). */
function providerToken(): string | null {
  const { keyP8Base64, keyId, teamId } = config.apns;
  if (!keyP8Base64 || !keyId || !teamId) return null;
  if (cachedJwt && Date.now() - cachedJwt.at < JWT_TTL_MS) return cachedJwt.token;

  const pem = Buffer.from(keyP8Base64, 'base64').toString('utf8');
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const payload = base64url(JSON.stringify({ iss: teamId, iat: Math.floor(Date.now() / 1000) }));
  const signer = createSign('SHA256');
  signer.update(`${header}.${payload}`);
  // ES256 은 DER 이 아니라 P1363(r||s) 형식을 요구한다 — dsaEncoding 을 지정하지 않으면
  //  애플이 InvalidProviderToken 을 돌려준다.
  const sig = signer.sign({ key: pem, dsaEncoding: 'ieee-p1363' });

  const token = `${header}.${payload}.${base64url(sig)}`;
  cachedJwt = { token, at: Date.now() };
  return token;
}

/** 요청 하나가 이 시간을 넘기면 포기한다 — 알림이 원 요청을 붙잡고 있으면 안 된다. */
const REQ_TIMEOUT_MS = 10_000;

// APNs 는 연결을 오래 재사용하기를 권한다(매 발송마다 TLS 를 새로 맺으면 느리고, 애플이
//  연결 폭주를 제한한다). 환경별로 하나씩 들고 있다가 끊기면 버린다.
const sessions = new Map<Env, http2.ClientHttp2Session>();

function apnsSession(env: Env): http2.ClientHttp2Session {
  const live = sessions.get(env);
  if (live && !live.closed && !live.destroyed) return live;

  const s = http2.connect(GATEWAY[env]);
  const drop = () => { if (sessions.get(env) === s) sessions.delete(env); };
  // error 핸들러가 없으면 연결 실패가 프로세스를 죽인다. 실제 보고는 요청 쪽에서 한다.
  s.on('error', drop);
  s.on('close', drop);
  s.on('goaway', drop);
  s.unref();   // 유휴 연결이 프로세스 종료를 붙잡지 않게 한다(스크립트·테스트).
  sessions.set(env, s);
  return s;
}

function apnsPost(env: Env, deviceToken: string, jwt: string, bodyJson: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    let req: http2.ClientHttp2Stream;
    try {
      req = apnsSession(env).request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${jwt}`,
        'apns-topic': config.apns.topic,
        'apns-push-type': 'alert',
        'content-type': 'application/json',
      });
    } catch (err) {
      sessions.delete(env);   // 이미 죽은 세션을 물고 있었다
      reject(err);
      return;
    }

    let status = 0;
    let body = '';
    req.setTimeout(REQ_TIMEOUT_MS, () => req.destroy(new Error('APNs 응답 없음(타임아웃)')));
    req.on('response', (h) => { status = Number(h[':status'] ?? 0); });
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve({ status, body }));
    req.on('error', reject);
    req.end(bodyJson);
  });
}

/**
 * 한 번 실패하면 연결을 버리고 한 번만 더 시도한다.
 *
 * 재사용하던 연결을 애플이 조용히 닫는 일이 흔하다 — 우리는 그걸 다음 발송에서야 알게 되고,
 * 그때 첫 시도는 실패한다. 새 연결로 한 번 더 하면 넘어간다. 진짜 장애면 두 번째도 실패한다.
 */
async function apnsSend(env: Env, deviceToken: string, jwt: string, bodyJson: string) {
  try {
    return await apnsPost(env, deviceToken, jwt, bodyJson);
  } catch {
    sessions.get(env)?.destroy();
    sessions.delete(env);
    return await apnsPost(env, deviceToken, jwt, bodyJson);
  }
}

export type PushPayload = {
  title: string;
  body: string;
  /** 앱이 어느 화면으로 갈지 정하는 값. type + 아이디만 있으면 된다(앱 팀 확인). */
  data: Record<string, string>;
  /** iOS 가 같은 대상의 알림을 묶는 키. 예: post:{postId} */
  threadId?: string;
};

/**
 * 한 사람의 모든 기기에 보낸다.
 *
 * ⚠️ **던지지 않는다.** 알림 실패로 원 요청(좋아요·댓글·합류)이 500 이 되면, 사용자는 자기
 *    행동이 실패한 것으로 본다. 알림은 부수 효과이고 원 행동보다 중요하지 않다.
 *
 * `eventKey` 가 있으면 중복 억제 창(config.apns.likeDedupeHours) 안에서 한 번만 보낸다.
 */
export async function pushToAuthor(
  authorId: number,
  payload: PushPayload,
  eventKey?: string,
): Promise<void> {
  try {
    if (eventKey) {
      const dup = await query(
        `select 1 from push_sends
          where author_id = $1 and event_key = $2 and ok
            and created_at > now() - make_interval(hours => $3)
          limit 1`,
        [authorId, eventKey, config.apns.likeDedupeHours],
      );
      if (dup.rowCount) return;   // 창 안에서 이미 보냈다
    }

    const devices = (await query<{ token: string; environment: string }>(
      'select token, environment from device_tokens where author_id = $1', [authorId],
    )).rows;
    if (devices.length === 0) return;   // 알림을 안 켠 사람 — 정상 경로다

    const jwt = providerToken();
    if (!jwt) {
      // 키가 없으면 콘솔로 보낸다(mailer 와 같은 판단). 로컬에서 트리거를 검증할 수 있다.
      console.log(`[push] (콘솔 — APNS 키 미설정) → author ${authorId} · ${payload.title}`
        + `\n  | ${payload.body}\n  | data=${JSON.stringify(payload.data)} devices=${devices.length}`);
      await log(authorId, eventKey, true, 'console');
      return;
    }

    const aps: Record<string, unknown> = {
      alert: { title: payload.title, body: payload.body },
      sound: 'default',
      // 뱃지는 넣지 않는다(파일 상단 주석).
    };
    if (payload.threadId) aps['thread-id'] = payload.threadId;
    const bodyJson = JSON.stringify({ aps, ...payload.data });

    let anyOk = false;
    const failures: string[] = [];

    for (const d of devices) {
      const env: Env = d.environment === 'sandbox' ? 'sandbox' : 'production';
      try {
        const res = await apnsSend(env, d.token, jwt, bodyJson);
        if (res.status === 200) { anyOk = true; continue; }

        const text = res.body.slice(0, 300);
        failures.push(`${res.status} ${text}`);
        // 410 Unregistered = 앱이 지워졌거나 토큰이 폐기됐다. 쌓아 두면 발송량이 계속 늘고
        //  실패율 지표가 흐려지므로 지운다(앱 팀 요청 5-1).
        // 400 BadDeviceToken 도 같다 — 그 토큰으로는 앞으로도 못 보낸다.
        if (res.status === 410 || text.includes('Unregistered') || text.includes('BadDeviceToken')) {
          await query('delete from device_tokens where token = $1', [d.token]);
        }
      } catch (err) {
        failures.push(String(err).slice(0, 200));
      }
    }

    await log(authorId, eventKey, anyOk, failures.length ? failures.join(' | ').slice(0, 500) : null);
    if (!anyOk && failures.length) console.warn(`[push] author ${authorId} 발송 실패: ${failures[0]}`);
  } catch (err) {
    // 알림 경로의 예외가 원 요청을 깨뜨리지 않게 여기서 삼킨다(위 주석).
    console.error('[push] 예외:', err);
  }
}

async function log(authorId: number, eventKey: string | undefined, ok: boolean, detail: string | null) {
  // eventKey 가 없는 알림(댓글 등)도 이력은 남긴다 — 진단에 쓰인다. 중복 억제만 키를 요구한다.
  await query(
    'insert into push_sends (author_id, event_key, ok, detail) values ($1, $2, $3, $4)',
    [authorId, eventKey ?? '-', ok, detail],
  ).catch(() => {});
}

/** 알림 문구에 남의 글 본문을 인용할 때 쓴다 — 잠금화면에 그대로 보이므로 짧게 자른다. */
export function quote(text: string, max = 40): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
