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
  normalizeEmail,
  signIn,
  signOutDevice,
} from './accounts';
import {
  burnVerifyTime,
  hashPassword,
  passwordPolicyError,
  verifyPassword,
} from './password';
import type { AppEnv } from './middleware';
import { issueSession, revokeDeviceSessions, revokeSession } from './sessions';

// 이메일 형식 — 완벽한 RFC 검증은 불가능하고 실익도 없다. 명백한 오타만 걸러내고
//  진짜 소유 확인은 인증 메일이 맡는다(도메인 확보 후 별도 단계).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254; // RFC 5321 의 주소 상한
const MAX_NICKNAME_LENGTH = 40; // authors.nickname — 다른 라우트와 같은 상한

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
const attempts = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 10 * 60_000;

function clientId(c: Context<AppEnv>): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'anon';
}

function tooManyAttempts(c: Context<AppEnv>): boolean {
  const cur = attempts.get(clientId(c));
  return !!cur && Date.now() < cur.resetAt && cur.count >= config.auth.maxLoginAttempts;
}

function recordFailure(c: Context<AppEnv>): void {
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
type AuthorView = { uuid: string; nickname: string; email: string | null; emailVerified: boolean };

function viewOf(r: SignInResult): AuthorView {
  return { uuid: r.uuid, nickname: r.nickname, email: r.email, emailVerified: r.emailVerified };
}

/** 로그인·가입의 공통 마무리 — 병합은 signIn 이 이미 했고, 여기서는 세션만 낸다. */
async function finishSignIn(result: SignInResult, deviceId: string) {
  const session = await issueSession(result.authorId, deviceId || null);
  return {
    token: session.token,
    expiresAt: session.expiresAt,
    author: viewOf(result),
    // 앱이 "기존에 작성하신 내용을 가져왔습니다" 안내를 띄울지 판단하는 값.
    merged: result.merged,
    created: result.created,
  };
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
    const p = await readBody(c);
    if (!p) return c.json({ error: 'invalid_body', message: 'JSON 객체를 보내주세요.' }, 400);

    const email = normalizeEmail(str(p.email));
    const password = typeof p.password === 'string' ? p.password : '';
    const nickname = str(p.nickname);
    const deviceId = str(p.deviceId);

    if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
      return c.json({ error: 'invalid_email', message: '이메일 형식이 올바르지 않습니다.' }, 400);
    }
    const policy = passwordPolicyError(password);
    if (policy) return c.json({ error: 'invalid_password', message: policy }, 400);
    if (nickname.length > MAX_NICKNAME_LENGTH) {
      return c.json({ error: 'invalid_nickname', message: `닉네임은 ${MAX_NICKNAME_LENGTH}자 이하여야 합니다.` }, 400);
    }

    // 가입은 "이미 있는 이메일"을 알려줘야 한다 — 안 알려주면 사용자가 가입을 못 한다.
    //  (로그인과 달리 여기서는 열거를 감수한다. 대신 시도 제한이 걸려 있다)
    if (await findEmailIdentity(email)) {
      return c.json({ error: 'email_taken', message: '이미 가입된 이메일입니다. 로그인해주세요.' }, 409);
    }

    const passwordHash = await hashPassword(password);
    const result = await signIn({
      identity: { provider: 'email', subject: email, email },
      deviceId,
      nickname,
      passwordHash,
    });
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
    if (!email || !password) return invalidCredentials(c);

    const identity = await findEmailIdentity(email);
    // 계정이 없거나 비밀번호가 없는 신원(소셜로만 가입)이어도 같은 시간을 쓰고 같은 답을 준다.
    const ok = identity?.passwordHash
      ? await verifyPassword(password, identity.passwordHash)
      : await burnVerifyTime(password);
    if (!ok) {
      recordFailure(c);
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

    const p = await readBody(c);
    const deviceId = str(p?.deviceId);

    await revokeSession(token);
    if (deviceId) {
      await revokeDeviceSessions(deviceId);
      await signOutDevice(deviceId);
    }
    return c.json({ ok: true });
  });

  // ── 현재 계정 ──────────────────────────────────────────────────────────────
  //  앱 기동 시 저장해 둔 토큰이 아직 쓸 수 있는지 확인하는 용도.
  //  만료됐으면 sessionAuth 가 이미 401 을 냈으므로 여기 도달하지 않는다.
  auth.get('/me', async (c) => {
    const authorId = c.get('authorId');
    if (authorId == null) return c.json({ error: 'unauthenticated', message: '로그인 상태가 아닙니다.' }, 401);

    const row = (await query<{ uuid: string; nickname: string; email: string | null; verified: Date | null }>(
      'select uuid, nickname, email, email_verified_at as verified from authors where id = $1',
      [authorId],
    )).rows[0];
    if (!row) return c.json({ error: 'not_found', message: '계정을 찾을 수 없습니다.' }, 404);

    return c.json({
      uuid: row.uuid,
      nickname: row.nickname,
      email: row.email,
      emailVerified: row.verified != null,
    } satisfies AuthorView);
  });

  return auth;
}
