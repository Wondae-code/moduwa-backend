// 피드백 라우트 — POST /v1/feedback (docs/FEEDBACK.md)
//
// 앱의 세 곳(문의하기 · 장소 상세 · 여행 상세)이 같은 시트로 보낸다. 운영은 대시보드에서 본다.
//
// ⚠️ **로그인하지 않아도 보낼 수 있다.** 그래서 requireAuth 를 부르지 않는다. 세션이 있으면
//    그 계정을 함께 남기고, 없으면 deviceId 만 남는다. 낡은 토큰은 sessionAuth 가 이미 401 로
//    돌려보냈으므로 여기까지 오지 않는다.
//
// ⚠️ **deviceId 는 신원이 아니다.** 묶어 보기용으로 저장만 한다. 이 파일에 "내 피드백" 조회를
//    만들지 않는 것이 그 규칙의 핵심이다(059 주석).
import { Hono } from 'hono';
import type { Context } from 'hono';
import { query } from '../db';
import { normalizeEmail } from './accounts';
import type { AppEnv } from './middleware';
import { clientIp } from './middleware';

/** 열린 곳. 앱의 시트가 이 셋 중 하나를 싣는다. */
const CATEGORIES = new Set(['inquiry', 'place', 'plan']);

/** 본문 상한. **화면에 보이는 글자** 로 센다(visibleLength). */
const MAX_BODY_CHARS = 500;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; // auth-routes.ts 와 같은 규칙
const MAX_EMAIL_LENGTH = 254; // RFC 5321 의 주소 상한
const MAX_DEVICE_ID_LENGTH = 128; // 다른 쓰기 라우트와 같은 상한
const MAX_CONTENT_ID_LENGTH = 64; // 후기의 contentId 와 같은 상한
// 검사하지 않는 칸이라 상한이 없으면 아무거나 무한정 쌓인다. 기기 정보 다섯 개는 200바이트 안팎이다.
const MAX_CLIENT_BYTES = 2048;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * 보관 기간(일). 지나면 purgeExpiredFeedback 이 지운다.
 * ⚠️ 개인정보 처리방침 4항(legal-pages.ts)과 같아야 한다. 바꾸면 그쪽도 같은 커밋에서 고친다.
 */
export const FEEDBACK_RETENTION_DAYS = 365;

// ── 글자 수 ──────────────────────────────────────────────────────────────────
//  ⚠️ `.length` 로 세면 안 된다. UTF-16 단위라 이모지 하나가 2자 이상이 되는데, iOS 의
//     String.count 는 1자로 센다 — 앱 화면은 500자 안이라고 하는데 서버가 거절하게 된다.
//     다른 라우트는 상한이 넉넉해(2000·5000자) 드러나지 않았지만 500자는 빠듯하다.
const graphemes = new Intl.Segmenter('ko', { granularity: 'grapheme' });

function visibleLength(s: string): number {
  let n = 0;
  for (const _ of graphemes.segment(s)) n++;
  return n;
}

// ── 보내기 횟수 제한 ─────────────────────────────────────────────────────────
//  비로그인도 보낼 수 있으므로 계정 기준으로는 막을 수 없다. 공통 레이트리밋은 API 키 기준이라
//  앱 설치 전체가 한 버킷을 쓴다(middleware.ts) — 그래서 여기서 IP 기준으로 따로 센다.
//  deviceId 기준은 두지 않는다. 클라이언트가 매번 바꿔 보내면 그만이다.
//  ⚠️ 이동통신망은 여러 사람이 IP 하나를 나눠 쓰는 경우가 많다. 창 10분에 10건이면 한 사람이
//     연달아 보내기에는 충분하고, 도배는 무의미해지는 선이다.
const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 10;
const sent = new Map<string, { count: number; resetAt: number }>();

function tooMany(c: Context<AppEnv>): boolean {
  const cur = sent.get(clientIp(c));
  return !!cur && Date.now() < cur.resetAt && cur.count >= MAX_PER_WINDOW;
}

/** 접수된 것만 센다. 형식이 틀려 거절된 요청까지 세면 앱 버그 하나로 사용자가 막힌다. */
function recordSent(c: Context<AppEnv>): void {
  const id = clientIp(c);
  const now = Date.now();
  const cur = sent.get(id);
  if (!cur || now >= cur.resetAt) sent.set(id, { count: 1, resetAt: now + WINDOW_MS });
  else cur.count += 1;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sent) if (now >= v.resetAt) sent.delete(k);
}, 300_000).unref?.();

// ── 보관 기간 ────────────────────────────────────────────────────────────────
/** 보관 기간이 지난 피드백을 지운다. 지운 건수를 돌려준다. */
export async function purgeExpiredFeedback(): Promise<number> {
  const res = await query(
    `delete from feedback where created_at < now() - make_interval(days => $1)`,
    [FEEDBACK_RETENTION_DAYS],
  );
  return res.rowCount ?? 0;
}

/**
 * 서버가 떠 있는 동안 하루에 한 번 보관 기간을 지킨다. 기동 직후에도 한 번 돈다.
 *
 * ⚠️ 실패해도 서버를 멈추지 않는다 — 059 를 아직 적용하지 않은 DB 에서는 테이블이 없어 실패하는데,
 *    그 때문에 API 전체가 내려가면 안 된다. 로그에 남겨 드러나게만 한다.
 */
export function scheduleFeedbackPurge(): void {
  const run = () => {
    purgeExpiredFeedback()
      .then((n) => { if (n > 0) console.log(`[feedback] 보관 기간(${FEEDBACK_RETENTION_DAYS}일)이 지난 피드백 ${n}건 삭제`); })
      .catch((err: Error) => console.warn(`[feedback] 보관 기간 정리 실패: ${err.message}`));
  };
  run();
  setInterval(run, 24 * 60 * 60_000).unref?.();
}

// ── 라우트 ───────────────────────────────────────────────────────────────────
const bad = (c: Context, error: string, message: string) => c.json({ error, message }, 400);

export function buildFeedbackRoutes(): Hono<AppEnv> {
  const feedback = new Hono<AppEnv>();

  feedback.post('/', async (c) => {
    if (tooMany(c)) {
      return c.json({ error: 'rate_limited', message: '잠시 후 다시 보내 주세요.' }, 429);
    }

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json', message: 'JSON 본문을 파싱할 수 없습니다.' }, 400);
    }
    const p = (payload ?? {}) as Record<string, unknown>;

    const category = typeof p.category === 'string' ? p.category.trim() : '';
    if (!CATEGORIES.has(category)) {
      return bad(c, 'invalid_category', `category 는 ${[...CATEGORIES].join(' · ')} 중 하나여야 합니다.`);
    }

    const body = typeof p.body === 'string' ? p.body.trim() : '';
    // 큰 문자열을 통째로 쪼개 보기 전에 넉넉한 상한으로 먼저 자른다. 글자 하나가 UTF-16 으로
    //  아무리 길어도(가족 이모지 11단위) 16배를 넘지 않는다.
    if (!body || body.length > MAX_BODY_CHARS * 16 || visibleLength(body) > MAX_BODY_CHARS) {
      return bad(c, 'invalid_body', `내용은 1~${MAX_BODY_CHARS}자여야 합니다.`);
    }

    // ⚠️ 대상은 형식만 본다. 존재를 확인하면 그 사이 지워진 플랜에 대한 피드백이 실패하고,
    //    제보를 잃는다. 대상이 없다는 것은 운영 화면에서 보면 된다.
    const rawTarget = typeof p.targetId === 'string' ? p.targetId.trim() : '';
    let targetId: string | null = null;
    if (category === 'place' && rawTarget) {
      if (rawTarget.length > MAX_CONTENT_ID_LENGTH) {
        return bad(c, 'invalid_target', `장소 targetId 는 ${MAX_CONTENT_ID_LENGTH}자 이하여야 합니다.`);
      }
      targetId = rawTarget;
    } else if (category === 'plan' && rawTarget) {
      if (!UUID_RE.test(rawTarget)) {
        return bad(c, 'invalid_target', '여행 targetId 는 플랜 id(uuid)여야 합니다.');
      }
      targetId = rawTarget.toLowerCase();
    }
    // inquiry 의 targetId 는 무시한다 — 가리킬 대상이 없다.

    // 빈 문자열은 "없음" 이다. 앱이 빈 칸을 그대로 실어 보내도 오류가 되지 않게 한다.
    if (p.replyEmail != null && typeof p.replyEmail !== 'string') {
      return bad(c, 'invalid_email', '이메일 형식이 올바르지 않습니다.');
    }
    const replyEmail = normalizeEmail(p.replyEmail ?? '') || null;
    if (replyEmail && (replyEmail.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(replyEmail))) {
      return bad(c, 'invalid_email', '이메일 형식이 올바르지 않습니다.');
    }

    const deviceId = typeof p.deviceId === 'string' ? p.deviceId.trim() : '';
    if (deviceId.length > MAX_DEVICE_ID_LENGTH) {
      return bad(c, 'invalid_deviceId', `deviceId 는 ${MAX_DEVICE_ID_LENGTH}자 이하여야 합니다.`);
    }

    let client: string | null = null;
    if (p.client != null) {
      if (typeof p.client !== 'object' || Array.isArray(p.client)) {
        return bad(c, 'invalid_client', 'client 는 객체여야 합니다.');
      }
      client = JSON.stringify(p.client);
      if (Buffer.byteLength(client) > MAX_CLIENT_BYTES) {
        return bad(c, 'invalid_client', `client 는 ${MAX_CLIENT_BYTES}바이트 이하여야 합니다.`);
      }
    }

    const authorId = c.get('authorId') ?? null;
    const row = (await query<{ id: number }>(
      `insert into feedback (author_id, device_id, category, target_id, body, reply_email, client)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb) returning id`,
      [authorId, deviceId || null, category, targetId, body, replyEmail, client],
    )).rows[0]!;
    recordSent(c);

    return c.json({ id: row.id }, 201);
  });

  return feedback;
}
