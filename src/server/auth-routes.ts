// 계정 인증 라우트 — /v1/auth/*
//
// 지금은 이메일 로그인만 붙인다. 애플·구글·카카오·네이버는 "토큰을 검증해서
// VerifiedIdentity 를 만드는 부분"만 다르고, 그 뒤(계정 찾기·익명 데이터 병합·세션 발급)는
// 전부 이 파일의 finishSignIn 을 그대로 탄다.
//
// ⚠️ 이 라우트들은 v1 아래 있으므로 **API 키 인증을 이미 통과한 요청**이다.
//    API 키는 "이 앱이 호출해도 되는가", 여기서 다루는 건 "이 사람이 누구인가"다.
import { Hono } from 'hono';
import type { Context } from 'hono';
import { config } from '../config';
import { query } from '../db';
import {
  type SignInResult,
  findEmailIdentity,
  markEmailVerified,
  normalizeEmail,
  setEmailPassword,
  signIn,
  signOutDevice,
} from './accounts';
import { type CodePurpose, consumeCode, issueCode, secondsSinceLastCode } from './email-codes';
import { buildCodeMail, sendMail } from './mailer';
import {
  MAX_PASSWORD_LENGTH,
  burnVerifyTime,
  hashPassword,
  passwordPolicyError,
  verifyPassword,
} from './password';
import { type AppEnv, clientIp } from './middleware';
import { issueSession, revokeAuthorSessions, revokeDeviceSessions, revokeSession } from './sessions';

// 이메일 형식 — 완벽한 RFC 검증은 불가능하고 실익도 없다. 명백한 오타만 걸러내고
//  진짜 소유 확인은 인증 메일이 맡는다(도메인 확보 후 별도 단계).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254; // RFC 5321 의 주소 상한
const MAX_NICKNAME_LENGTH = 40; // authors.nickname — 다른 라우트와 같은 상한
const MAX_DEVICE_ID_LENGTH = 128; // app.ts 의 다른 쓰기 라우트와 같은 상한
// 무장애 항목 개수 상한. 앱이 항목을 늘려도 서버 배포 없이 따라가야 하므로 값은 검증하지
//  않지만(030 주석), 개수는 막는다 — 검증하지 않는 배열에 상한이 없으면 그대로 저장소가 된다.
const MAX_ACCESS_FEATURES = 32;

/**
 * 로그인 실패 응답. **이유를 나누지 않는다.**
 * "없는 계정"과 "비밀번호 틀림"을 구분해 주면 그것만으로 가입 여부를 알아낼 수 있다
 * (user enumeration). 응답 시간도 password.ts 의 burnVerifyTime 으로 맞춘다.
 */
function invalidCredentials(c: Context<AppEnv>) {
  return c.json(
    { error: 'invalid_credentials', message: '이메일 또는 비밀번호가 올바르지 않습니다.' },
    401,
  );
}

// ── 로그인 시도 제한 ─────────────────────────────────────────────────────────
//  단일 인스턴스 인메모리. dashboard-auth.ts 와 같은 방식이다 — 무차별 대입을 "막는" 게
//  아니라 실용적으로 무의미하게 만드는 용도.
//  ⚠️ IP 기준이라 같은 회사·학교에서 여러 명이 쓰면 함께 걸릴 수 있다. 창이 10분이라
//     실사용에 문제되지 않는 선이고, 계정별로 잠그면 남의 계정을 잠글 수 있어 더 나쁘다.
//  IP 는 clientIp() 로 얻는다 — XFF 첫 항목을 쓰면 헤더 한 줄로 제한이 우회된다.
const attempts = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 10 * 60_000;

function clientId(c: Context<AppEnv>): string {
  // ⚠️ XFF 의 첫 항목을 쓰면 안 된다 — 클라이언트가 바꿀 수 있어 제한이 무의미해진다.
  //    신뢰 홉 수를 반영한 clientIp() 를 쓴다(middleware.ts).
  return clientIp(c);
}

function tooManyAttempts(c: Context<AppEnv>): boolean {
  const cur = attempts.get(clientId(c));
  return !!cur && Date.now() < cur.resetAt && cur.count >= config.auth.maxLoginAttempts;
}

/** 시도 1건 기록. 로그인은 실패만, 가입은 성공까지 센다(아래 주석 참고). */
function recordAttempt(c: Context<AppEnv>): void {
  const id = clientId(c);
  const now = Date.now();
  const cur = attempts.get(id);
  if (!cur || now >= cur.resetAt) attempts.set(id, { count: 1, resetAt: now + WINDOW_MS });
  else cur.count += 1;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) if (now >= v.resetAt) attempts.delete(k);
}, 300_000).unref?.();

// ── 응답 모양 ────────────────────────────────────────────────────────────────
//  ⚠️ deviceId 는 어떤 응답에도 넣지 않는다(017 이후의 규칙). authors.id 도 마찬가지로
//     내보내지 않는다 — 외부에는 uuid 만 노출한다.
type AuthorView = {
  uuid: string;
  nickname: string;
  email: string | null;
  emailVerified: boolean;
  /** 온보딩에서 고른 무장애 항목(030). 앱이 로컬 값과 맞추는 데 쓴다. */
  accessFeatures: string[];
  onboarded: boolean;
};

function viewOf(r: SignInResult): AuthorView {
  return {
    uuid: r.uuid, nickname: r.nickname, email: r.email, emailVerified: r.emailVerified,
    accessFeatures: r.accessFeatures, onboarded: r.onboarded,
  };
}

/** 로그인·가입의 공통 마무리 — 병합은 signIn 이 이미 했고, 여기서는 세션만 낸다. */
async function finishSignIn(result: SignInResult, deviceId: string) {
  const session = await issueSession(result.authorId, deviceId || null);
  return {
    token: session.token,
    expiresAt: session.expiresAt,
    author: viewOf(result),
    // 가입인지 로그인인지. 앱이 온보딩 완료 처리·환영 화면 분기에 쓴다.
    created: result.created,
  };
}

// 같은 목적의 코드를 다시 보내기까지 기다려야 하는 최소 간격(초).
//  없으면 남의 주소에 대고 재발송을 반복해 **메일 폭탄**을 보낼 수 있다.
const RESEND_INTERVAL_SEC = 60;

/**
 * 코드를 발급해 메일로 보낸다.
 *
 * 발송 실패로 요청을 실패시키지 않는다(mailer.sendMail 주석 참고) — 실패가 곧
 * "이 주소는 가입돼 있다"는 신호가 되고, 가입 직후라면 사용자가 빠져나갈 방법이 없어진다.
 * 실패는 서버 로그에 남고 사용자는 재발송을 누르면 된다.
 */
async function issueAndSend(authorId: number, purpose: CodePurpose, email: string): Promise<void> {
  const { code, minutes } = await issueCode(authorId, purpose, email);
  const mail = buildCodeMail(purpose, code, minutes);
  await sendMail({ to: email, ...mail });
}

/** 코드 검증 실패 응답. 사유별로 앱이 다른 안내를 띄울 수 있게 코드를 나눈다. */
function codeError(c: Context<AppEnv>, reason: 'invalid' | 'expired' | 'too_many') {
  if (reason === 'expired') {
    return c.json({ error: 'code_expired', message: '코드가 만료되었습니다. 다시 받아주세요.' }, 400);
  }
  if (reason === 'too_many') {
    return c.json({ error: 'code_attempts_exceeded', message: '시도 횟수를 초과했습니다. 코드를 다시 받아주세요.' }, 429);
  }
  return c.json({ error: 'invalid_code', message: '코드가 올바르지 않습니다.' }, 400);
}

/** 본문 파싱 — 다른 라우트와 같은 방식(JSON 객체가 아니면 400). */
async function readBody(c: Context<AppEnv>): Promise<Record<string, unknown> | null> {
  try {
    const p = await c.req.json();
    return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function buildAuthRoutes(): Hono<AppEnv> {
  const auth = new Hono<AppEnv>();

  // ── 이메일 가입 ────────────────────────────────────────────────────────────
  //  가입 시점에 이 기기의 익명 데이터를 계정으로 가져온다(signIn 의 ①·③ 경로).
  //  그래서 deviceId 를 함께 받는다 — 없으면 익명으로 쓴 후기·플랜이 그대로 버려진다.
  auth.post('/email/sign-up', async (c) => {
    // 가입도 제한한다. 409/201 이 갈리므로 이 경로는 그 자체로 이메일 열거 수단이고,
    // 계정을 실제로 만들 수 있어 대량 가입에도 쓰인다.
    if (tooManyAttempts(c)) {
      return c.json({ error: 'too_many_attempts', message: '요청이 많습니다. 잠시 후 다시 시도해주세요.' }, 429);
    }
    // 로그인과 달리 **성공도 센다.** 실패만 세면 매번 새 이메일로 찍는 열거·대량 가입이
    // 카운터를 전혀 올리지 않아 제한이 걸리지 않는다(409 만 세면 그 경로만 막힌다).
    recordAttempt(c);
    const p = await readBody(c);
    if (!p) return c.json({ error: 'invalid_body', message: 'JSON 객체를 보내주세요.' }, 400);

    const email = normalizeEmail(str(p.email));
    const password = typeof p.password === 'string' ? p.password : '';
    const nickname = str(p.nickname);
    const deviceId = str(p.deviceId);
    // 온보딩에서 고른 무장애 항목. 앱 로컬에 있던 값이 여기 실려 온다.
    //  키가 아예 없으면 undefined 로 둔다 — "온보딩을 안 했다"와 "아무것도 고르지 않았다"를
    //  구분해야 하고, signIn 이 그 차이로 onboarded_at 을 찍을지 결정한다.
    const accessFeatures = p.accessFeatures === undefined
      ? undefined
      : (Array.isArray(p.accessFeatures)
          ? p.accessFeatures.filter((v): v is string => typeof v === 'string' && v.length <= 40).slice(0, MAX_ACCESS_FEATURES)
          : []);

    if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
      return c.json({ error: 'invalid_email', message: '이메일 형식이 올바르지 않습니다.' }, 400);
    }
    const policy = passwordPolicyError(password);
    if (policy) return c.json({ error: 'invalid_password', message: policy }, 400);
    if (nickname.length > MAX_NICKNAME_LENGTH) {
      return c.json({ error: 'invalid_nickname', message: `닉네임은 ${MAX_NICKNAME_LENGTH}자 이하여야 합니다.` }, 400);
    }
    if (deviceId.length > MAX_DEVICE_ID_LENGTH) {
      return c.json({ error: 'invalid_deviceId', message: `deviceId 는 ${MAX_DEVICE_ID_LENGTH}자 이하여야 합니다.` }, 400);
    }

    // 가입은 "이미 있는 이메일"을 알려줘야 한다 — 안 알려주면 사용자가 가입을 못 한다.
    //  열거를 감수하는 대신 위의 시도 제한으로 속도를 묶는다(중복 응답도 실패로 센다).
    if (await findEmailIdentity(email)) {
      return c.json({ error: 'email_taken', message: '이미 가입된 이메일입니다. 로그인해주세요.' }, 409);
    }

    const passwordHash = await hashPassword(password);
    const result = await signIn({
      identity: { provider: 'email', subject: email, email },
      deviceId,
      nickname,
      passwordHash,
      accessFeatures,
    });
    // 가입 직후 인증 코드를 보낸다. 실패해도 가입은 성공으로 둔다 — 앱에서 재발송할 수 있다.
    await issueAndSend(result.authorId, 'verify', email);
    return c.json(await finishSignIn(result, deviceId), 201);
  });

  // ── 이메일 로그인 ──────────────────────────────────────────────────────────
  auth.post('/email/sign-in', async (c) => {
    if (tooManyAttempts(c)) {
      return c.json({ error: 'too_many_attempts', message: '로그인 시도가 많습니다. 잠시 후 다시 시도해주세요.' }, 429);
    }

    const p = await readBody(c);
    if (!p) return c.json({ error: 'invalid_body', message: 'JSON 객체를 보내주세요.' }, 400);

    const email = normalizeEmail(str(p.email));
    const password = typeof p.password === 'string' ? p.password : '';
    const deviceId = str(p.deviceId);
    // 길이 상한을 여기서도 본다. 없으면 수 MB 짜리 password 로 scrypt(요청당 32MB·수십 ms)를
    // 반복 유발해 libuv 스레드풀을 점유할 수 있다 — 사진 업로드까지 같이 밀린다.
    if (!email || !password) return invalidCredentials(c);
    if (email.length > MAX_EMAIL_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      recordAttempt(c);
      return invalidCredentials(c);
    }
    if (deviceId.length > MAX_DEVICE_ID_LENGTH) {
      return c.json({ error: 'invalid_deviceId', message: `deviceId 는 ${MAX_DEVICE_ID_LENGTH}자 이하여야 합니다.` }, 400);
    }

    const identity = await findEmailIdentity(email);
    // 계정이 없거나 비밀번호가 없는 신원(소셜로만 가입)이어도 같은 시간을 쓰고 같은 답을 준다.
    const ok = identity?.passwordHash
      ? await verifyPassword(password, identity.passwordHash)
      : await burnVerifyTime(password);
    if (!ok) {
      recordAttempt(c);
      return invalidCredentials(c);
    }

    // 병합·기기 바인딩은 signIn 이 전부 처리한다(가입과 같은 경로).
    const result = await signIn({
      identity: { provider: 'email', subject: email, email },
      deviceId,
    });
    return c.json(await finishSignIn(result, deviceId));
  });

  // ── 로그아웃 ───────────────────────────────────────────────────────────────
  //  세션 폐기와 기기 바인딩 해제를 **둘 다** 한다. 토큰만 끊고 바인딩을 두면 그 기기의
  //  다음 익명 요청이 여전히 계정으로 해석되어, 로그아웃했는데 계정 데이터가 다시 보인다.
  auth.post('/sign-out', async (c) => {
    const token = c.get('sessionToken');
    if (!token) return c.json({ error: 'unauthenticated', message: '로그인 상태가 아닙니다.' }, 401);

    // ⚠️ **본문의 deviceId 를 쓰지 않는다.** 예전에는 그 값을 그대로 믿어서, 유효한 세션 하나만
    //    있으면 남의 deviceId 를 넘겨 그 기기의 세션을 전부 폐기하고 바인딩까지 삭제할 수 있었다
    //    (피해자가 익명이면 그동안 쓴 것 전부에 도달할 수 없게 된다).
    //    끊을 기기는 **폐기한 세션 행에 기록된 것**뿐이고, 범위도 그 세션의 계정으로 좁힌다.
    const revoked = await revokeSession(token);
    // 세션 행에 device_id 가 없던 경우(기기를 못 알아낸 로그인)는 미들웨어가 넣어 준 값을 쓴다.
    const deviceId = revoked?.deviceId ?? c.get('sessionDeviceId') ?? '';
    if (revoked && deviceId) {
      await revokeDeviceSessions(deviceId, revoked.authorId);
      await signOutDevice(deviceId, revoked.authorId);
    }
    return c.json({ ok: true });
  });

  // ── 이메일 인증 ────────────────────────────────────────────────────────────
  //  가입 시 자동으로 한 번 보내고, 못 받았을 때 이 라우트로 재발송한다.
  //  세션을 요구한다 — 인증할 대상이 "지금 로그인한 계정"으로 특정되어야 하고,
  //  그래야 남의 주소에 대고 재발송을 유발할 수 없다.
  auth.post('/email/verify/request', async (c) => {
    const authorId = c.get('authorId');
    if (authorId == null) return c.json({ error: 'login_required', message: '로그인이 필요합니다.' }, 401);

    const row = (await query<{ email: string | null; verified: Date | null }>(
      'select email, email_verified_at as verified from authors where id = $1', [authorId],
    )).rows[0];
    if (!row?.email) return c.json({ error: 'no_email', message: '계정에 이메일이 없습니다.' }, 400);
    // 이미 인증된 계정에 또 보내지 않는다(메일 낭비이고 사용자도 혼란스럽다).
    if (row.verified) return c.json({ ok: true, alreadyVerified: true });

    const since = await secondsSinceLastCode(authorId, 'verify');
    if (since != null && since < RESEND_INTERVAL_SEC) {
      return c.json({
        error: 'resend_too_soon',
        message: `${RESEND_INTERVAL_SEC - since}초 후에 다시 시도해주세요.`,
        retryAfter: RESEND_INTERVAL_SEC - since,
      }, 429);
    }

    await issueAndSend(authorId, 'verify', normalizeEmail(row.email));
    return c.json({ ok: true });
  });

  auth.post('/email/verify', async (c) => {
    const authorId = c.get('authorId');
    if (authorId == null) return c.json({ error: 'login_required', message: '로그인이 필요합니다.' }, 401);

    const p = await readBody(c);
    const code = str(p?.code);
    const row = (await query<{ email: string | null }>(
      'select email from authors where id = $1', [authorId],
    )).rows[0];
    if (!row?.email) return c.json({ error: 'no_email', message: '계정에 이메일이 없습니다.' }, 400);

    const result = await consumeCode(authorId, 'verify', code, normalizeEmail(row.email));
    if (result !== 'ok') return codeError(c, result);

    await markEmailVerified(authorId, row.email);
    return c.json({ ok: true, emailVerified: true });
  });

  // ── 비밀번호 재설정 ────────────────────────────────────────────────────────
  //  ⚠️ 이 라우트는 **가입 여부를 알려주지 않는다.** 없는 주소든 있는 주소든 똑같이 200 이다.
  //     알려주면 그것만으로 이메일 열거가 되고, 그 목록이 곧 무차별 대입 대상이 된다.
  auth.post('/email/forgot', async (c) => {
    if (tooManyAttempts(c)) {
      return c.json({ error: 'too_many_attempts', message: '요청이 많습니다. 잠시 후 다시 시도해주세요.' }, 429);
    }
    recordAttempt(c);

    const p = await readBody(c);
    const email = normalizeEmail(str(p?.email));
    // 형식이 틀렸어도 같은 응답을 준다 — 응답이 갈리면 그것도 신호가 된다.
    if (email && email.length <= MAX_EMAIL_LENGTH && EMAIL_RE.test(email)) {
      const identity = await findEmailIdentity(email);
      // 비밀번호가 없는 신원(소셜로만 가입)에는 보내지 않는다 — 재설정할 비밀번호가 없다.
      if (identity?.passwordHash) {
        const since = await secondsSinceLastCode(identity.authorId, 'reset');
        // 간격 제한도 조용히 지나간다. 429 를 주면 "이 주소는 존재한다"가 새어 나간다.
        if (since == null || since >= RESEND_INTERVAL_SEC) {
          await issueAndSend(identity.authorId, 'reset', email);
        }
      }
    }
    return c.json({ ok: true, message: '가입된 주소라면 재설정 코드를 보냈습니다.' });
  });

  auth.post('/email/reset', async (c) => {
    if (tooManyAttempts(c)) {
      return c.json({ error: 'too_many_attempts', message: '요청이 많습니다. 잠시 후 다시 시도해주세요.' }, 429);
    }

    const p = await readBody(c);
    if (!p) return c.json({ error: 'invalid_body', message: 'JSON 객체를 보내주세요.' }, 400);
    const email = normalizeEmail(str(p.email));
    const code = str(p.code);
    const password = typeof p.password === 'string' ? p.password : '';

    const policy = passwordPolicyError(password);
    if (policy) return c.json({ error: 'invalid_password', message: policy }, 400);

    const identity = email ? await findEmailIdentity(email) : null;
    if (!identity) {
      recordAttempt(c);
      // 코드 검증 실패와 같은 응답을 준다 — 여기서 갈리면 열거가 된다.
      return codeError(c, 'invalid');
    }

    const result = await consumeCode(identity.authorId, 'reset', code, email);
    if (result !== 'ok') {
      recordAttempt(c);
      return codeError(c, result);
    }

    await setEmailPassword(identity.authorId, await hashPassword(password));
    // ⚠️ 비밀번호를 바꾸면 **모든 세션을 끊는다.** 계정을 되찾는 상황은 남이 들어와 있을 수
    //    있다는 뜻이고, 비밀번호만 바꾸고 그 사람의 세션을 살려 두면 되찾은 게 아니다.
    await revokeAuthorSessions(identity.authorId);
    return c.json({ ok: true, message: '비밀번호가 변경되었습니다. 다시 로그인해주세요.' });
  });

  // ── 현재 계정 ──────────────────────────────────────────────────────────────
  //  앱 기동 시 저장해 둔 토큰이 아직 쓸 수 있는지 확인하는 용도.
  //  만료됐으면 sessionAuth 가 이미 401 을 냈으므로 여기 도달하지 않는다.
  auth.get('/me', async (c) => {
    const authorId = c.get('authorId');
    if (authorId == null) return c.json({ error: 'unauthenticated', message: '로그인 상태가 아닙니다.' }, 401);

    const row = (await query<{
      uuid: string; nickname: string; email: string | null; verified: Date | null;
      access_features: string[]; onboarded_at: Date | null;
    }>(
      `select uuid, nickname, email, email_verified_at as verified, access_features, onboarded_at
         from authors where id = $1`,
      [authorId],
    )).rows[0];
    if (!row) return c.json({ error: 'not_found', message: '계정을 찾을 수 없습니다.' }, 404);

    return c.json({
      uuid: row.uuid,
      nickname: row.nickname,
      email: row.email,
      emailVerified: row.verified != null,
      accessFeatures: row.access_features,
      onboarded: row.onboarded_at != null,
    } satisfies AuthorView);
  });

  return auth;
}
