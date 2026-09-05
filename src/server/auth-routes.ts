// 계정 인증 라우트 — /v1/auth/*
//
// 이메일 + 소셜(애플·구글). 프로바이더마다 다른 것은 **토큰을 검증해 VerifiedIdentity 를
// 만드는 부분**뿐이고(social-tokens.ts), 그 뒤 — 계정 찾기·생성·기기 바인딩·세션 발급 —
// 은 전부 signIn 과 이 파일의 finishSignIn 을 그대로 탄다.
// 카카오·네이버도 검증 함수 하나만 늘리면 붙는다.
//
// ⚠️ 이 라우트들은 v1 아래 있으므로 **API 키 인증을 이미 통과한 요청**이다.
//    API 키는 "이 앱이 호출해도 되는가", 여기서 다루는 건 "이 사람이 누구인가"다.
import { Hono } from 'hono';
import type { Context } from 'hono';
import { config } from '../config';
import { query, withTransaction } from '../db';
import {
  type SignInResult,
  findEmailIdentity,
  markEmailVerified,
  setAccessFeatures,
  normalizeEmail,
  setEmailPassword,
  updateProfile,
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
import { exchangeCode as exchangeAppleCode, revoke as revokeApple } from './apple-auth';
import { type AppEnv, clientIp } from './middleware';
import {
  SocialNotConfiguredError,
  SocialTokenError,
  type SocialProfile,
  verifyAppleIdToken,
  verifyGoogleIdToken,
  verifyKakaoIdToken,
} from './social-tokens';
import { issueSession, revokeAuthorSessions, revokeDeviceSessions, revokeSession } from './sessions';

// 이메일 형식 — 완벽한 RFC 검증은 불가능하고 실익도 없다. 명백한 오타만 걸러내고
//  진짜 소유 확인은 인증 메일이 맡는다(도메인 확보 후 별도 단계).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254; // RFC 5321 의 주소 상한
const MAX_NICKNAME_LENGTH = 40; // authors.nickname — 다른 라우트와 같은 상한
// 프로필 사진 URL 상한. 우리 업로드 경로는 sha256 파일명이라 200자면 충분하고,
//  검증하지 않는 문자열에 상한이 없으면 그대로 저장소가 된다(accessFeatures 와 같은 규칙).
const MAX_AVATAR_URL_LENGTH = 300;
const MAX_DEVICE_ID_LENGTH = 128; // app.ts 의 다른 쓰기 라우트와 같은 상한
// 무장애 항목 개수 상한. 앱이 항목을 늘려도 서버 배포 없이 따라가야 하므로 값은 검증하지
//  않지만(030 주석), 개수는 막는다 — 검증하지 않는 배열에 상한이 없으면 그대로 저장소가 된다.
const MAX_ACCESS_FEATURES = 32;

/**
 * 탈퇴한 계정의 표시 이름.
 *
 * ⚠️ 빈 문자열이나 null 이 아니다 — authors.nickname 과 reviews.author_nm 이 not null 이고,
 *    앱도 이름 없는 작성자를 그리지 못한다. 남은 콘텐츠에 이 이름이 보인다.
 */
const DELETED_NICKNAME = '탈퇴한 사용자';

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
  /** 프로필 사진(042). 없으면 null — 앱이 이니셜 원을 그린다. */
  avatarUrl: string | null;
  /**
   * 접근성 특성은 있는데 **동의 기록이 없다**(050). 앱이 동의를 다시 받아야 한다.
   *
   * 동의를 안 받았다는 뜻이 아니라 기록하지 않았다는 뜻이다 — 기록을 시작하기 전에 등록한
   * 계정들이 여기 해당한다. 거부하면 앱이 accessFeatures 를 빈 배열로 보내 지운다.
   */
  needsSensitiveConsent: boolean;
};

function viewOf(r: SignInResult): AuthorView {
  return {
    uuid: r.uuid, nickname: r.nickname, email: r.email, emailVerified: r.emailVerified,
    accessFeatures: r.accessFeatures, onboarded: r.onboarded, avatarUrl: r.avatarUrl,
    needsSensitiveConsent: r.needsSensitiveConsent,
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

/** 계정 한 건을 AuthorView 로 읽는다 — GET /me 와 PATCH /me 가 공유한다. */
async function loadAuthorView(authorId: number): Promise<AuthorView | null> {
  const row = (await query<{
    uuid: string; nickname: string; email: string | null; verified: Date | null;
    access_features: string[]; onboarded_at: Date | null; avatar_url: string | null;
    consent_at: Date | null;
  }>(
    `select uuid, nickname, email, email_verified_at as verified, access_features, onboarded_at,
            avatar_url, sensitive_consent_at as consent_at
       from authors where id = $1`,
    [authorId],
  )).rows[0];
  if (!row) return null;
  return {
    uuid: row.uuid,
    nickname: row.nickname,
    email: row.email,
    emailVerified: row.verified != null,
    accessFeatures: row.access_features,
    onboarded: row.onboarded_at != null,
    avatarUrl: row.avatar_url,
    // 값은 있는데 동의 기록이 없다 — 앱이 다시 물어야 한다(050).
    needsSensitiveConsent: row.access_features.length > 0 && row.consent_at == null,
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
    // ⚠️ **가입 경로도 PATCH /me 와 같은 규칙으로 막는다**(050). 여기를 열어 두면 가드가
    //    무의미하다 — 동의 없이 민감정보를 넣고 싶으면 가입 요청에 실어 보내면 그만이다.
    if (accessFeatures && accessFeatures.length > 0 && p.sensitiveConsent !== true) {
      return c.json({
        error: 'sensitive_consent_required',
        message: '접근성 특성은 민감정보라 별도 동의가 필요합니다. sensitiveConsent 를 true 로 함께 보내주세요.',
      }, 400);
    }

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
      sensitiveConsent: p.sensitiveConsent === true,
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

  // ── 소셜 로그인 ────────────────────────────────────────────────────────────
  //  가입과 로그인이 **한 라우트**다. 소셜은 "계정이 있는지"를 사용자가 알 필요가 없고,
  //  묻는 화면을 두면 이미 가입한 사람이 가입 버튼을 눌러 실패하는 길만 생긴다.
  //  처음 온 신원이면 계정을 만들고 201, 있던 신원이면 200 이다.
  async function socialSignIn(
    c: Context<AppEnv>,
    provider: 'google' | 'apple' | 'kakao',
    verifyToken: (idToken: string) => Promise<SocialProfile>,
  ) {
    // 이메일 로그인과 같은 창을 쓴다. 토큰 검증은 서명 확인이라 값싸지만, 남의 서버(JWKS)를
    //  때리는 경로가 열려 있으면 그 자체로 증폭 수단이 된다.
    if (tooManyAttempts(c)) {
      return c.json({ error: 'too_many_attempts', message: '요청이 많습니다. 잠시 후 다시 시도해주세요.' }, 429);
    }

    const p = await readBody(c);
    if (!p) return c.json({ error: 'invalid_body', message: 'JSON 객체를 보내주세요.' }, 400);

    const idToken = str(p.idToken);
    const deviceId = str(p.deviceId);
    // 애플은 이름을 토큰에 담지 않고 **최초 인증 응답에서만** 준다. 앱이 그때 받은 이름을
    //  여기로 함께 보낸다. 새 계정의 초기 닉네임으로만 쓰인다(signIn 주석 참고).
    //  (구글은 토큰의 name, 카카오는 nickname 에 이름이 들어 있어 이 값이 없어도 된다)
    const nickname = str(p.nickname);
    // 애플만 쓰는 값. 계정 삭제 시 토큰 폐기에 필요한 refresh token 을 받아 두기 위한 것이다
    //  (심사 규칙 — apple-auth.ts 상단). 앱이 안 보내도 로그인은 그대로 된다.
    const authorizationCode = provider === 'apple' ? str(p.authorizationCode) : '';
    const accessFeatures = p.accessFeatures === undefined
      ? undefined
      : (Array.isArray(p.accessFeatures)
          ? p.accessFeatures.filter((v): v is string => typeof v === 'string' && v.length <= 40).slice(0, MAX_ACCESS_FEATURES)
          : []);
    // ⚠️ **가입 경로도 PATCH /me 와 같은 규칙으로 막는다**(050). 여기를 열어 두면 가드가
    //    무의미하다 — 동의 없이 민감정보를 넣고 싶으면 가입 요청에 실어 보내면 그만이다.
    if (accessFeatures && accessFeatures.length > 0 && p.sensitiveConsent !== true) {
      return c.json({
        error: 'sensitive_consent_required',
        message: '접근성 특성은 민감정보라 별도 동의가 필요합니다. sensitiveConsent 를 true 로 함께 보내주세요.',
      }, 400);
    }

    if (!idToken) {
      return c.json({ error: 'missing_idToken', message: '로그인 토큰이 없습니다.' }, 400);
    }
    if (nickname.length > MAX_NICKNAME_LENGTH) {
      return c.json({ error: 'invalid_nickname', message: `닉네임은 ${MAX_NICKNAME_LENGTH}자 이하여야 합니다.` }, 400);
    }
    if (deviceId.length > MAX_DEVICE_ID_LENGTH) {
      return c.json({ error: 'invalid_deviceId', message: `deviceId 는 ${MAX_DEVICE_ID_LENGTH}자 이하여야 합니다.` }, 400);
    }

    let profile: SocialProfile;
    try {
      profile = await verifyToken(idToken);
    } catch (error) {
      if (error instanceof SocialNotConfiguredError) {
        // 앱 잘못이 아니다. 서버가 클라이언트 ID 를 모르면 검증 자체를 할 수 없고,
        //  그 상태로 통과시키면 남의 앱 토큰까지 받아 준다(social-tokens.ts 상단).
        console.error(`[social] ${provider} 미설정 — 로그인 거부:`, (error as Error).message);
        return c.json({
          error: 'social_not_configured',
          message: '지금은 이 방식으로 로그인할 수 없습니다. 이메일로 로그인해주세요.',
        }, 503);
      }
      recordAttempt(c);
      if (error instanceof SocialTokenError) {
        return c.json({ error: 'invalid_token', message: '로그인 정보를 확인할 수 없습니다. 다시 시도해주세요.' }, 401);
      }
      throw error;
    }

    const result = await signIn({
      identity: { provider, subject: profile.subject, email: profile.email },
      deviceId,
      // 구글·카카오는 토큰에 이름이 있고, 애플은 앱이 보내 준다. 없으면 signIn 이 기본값을 쓴다.
      nickname: nickname || profile.name || '',
      accessFeatures,
      sensitiveConsent: p.sensitiveConsent === true,
    });

    // 프로바이더가 이메일 소유를 확인했다고 말하면 우리 계정도 인증된 것으로 본다 —
    //  그러지 않으면 구글로 가입한 사람에게 앱이 영원히 "이메일 인증 전"을 띄운다.
    //  markEmailVerified 는 **계정의 이메일이 그 주소와 같을 때만** 찍는다(사용자가 나중에
    //  주소를 바꿨으면 소셜 응답이 그것을 인증해 줄 근거가 없다).
    if (profile.email && profile.emailVerified) {
      await markEmailVerified(result.authorId, profile.email);
    }

    // 애플 refresh token 을 받아 둔다 — **계정 삭제 때만 쓴다.**
    //  ⚠️ 실패해도 로그인을 막지 않는다. 토큰 검증은 이미 끝났고, 이 값이 없으면 나중에
    //     폐기를 건너뛸 뿐이다. 로그인 경로에서 애플의 토큰 엔드포인트 장애를 사용자에게
    //     전가하는 것이 더 나쁘다.
    if (authorizationCode) {
      const refresh = await exchangeAppleCode(authorizationCode);
      if (refresh) {
        await query(
          `update author_identities set refresh_token = $3, updated_at = now()
            where provider = 'apple' and subject = $1 and author_id = $2`,
          [profile.subject, result.authorId, refresh],
        );
      }
    }

    const body = await finishSignIn(result, deviceId);
    // 인증 표시는 위에서 방금 바뀔 수 있다 — finishSignIn 이 읽은 값보다 이쪽이 최신이다.
    if (profile.email && profile.emailVerified) body.author.emailVerified = true;
    return c.json(body, result.created ? 201 : 200);
  }

  auth.post('/google', (c) => socialSignIn(c, 'google', verifyGoogleIdToken));
  auth.post('/apple', (c) => socialSignIn(c, 'apple', verifyAppleIdToken));
  auth.post('/kakao', (c) => socialSignIn(c, 'kakao', verifyKakaoIdToken));

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

    const view = await loadAuthorView(authorId);
    if (!view) return c.json({ error: 'not_found', message: '계정을 찾을 수 없습니다.' }, 404);
    return c.json(view);
  });

  // ── 무장애 프로필 수정 ─────────────────────────────────────────────────────
  //  가입 때 한 번 정하고 끝낼 값이 아니다 — 필요한 것은 바뀐다. 앱의 "내 정보" 화면이 쓴다.
  auth.patch('/me', async (c) => {
    const authorId = c.get('authorId');
    if (authorId == null) return c.json({ error: 'login_required', message: '로그인이 필요합니다.' }, 401);

    const p = await readBody(c);
    if (!p) return c.json({ error: 'invalid_body', message: 'JSON 객체를 보내주세요.' }, 400);

    // 부분 갱신이다 — 온 키만 바꾼다. 세 값의 "없음" 이 서로 달라서 각각 따로 본다
    //  (accounts.updateProfile 주석 참고).
    const patch: {
      nickname?: string;
      avatarUrl?: string | null;
      features?: string[];
      sensitiveConsent?: boolean;
    } = {};

    if (p.nickname !== undefined) {
      if (typeof p.nickname !== 'string') {
        return c.json({ error: 'invalid_nickname', message: '닉네임은 문자열이어야 합니다.' }, 400);
      }
      const nickname = p.nickname.trim();
      // 빈 문자열은 "지우기" 가 아니라 잘못된 입력이다 — authors.nickname 은 not null 이고,
      //  이름이 사라진 계정은 남의 글에서 작성자가 빈 칸으로 보인다.
      if (!nickname) {
        return c.json({ error: 'invalid_nickname', message: '닉네임을 입력해주세요.' }, 400);
      }
      if (nickname.length > MAX_NICKNAME_LENGTH) {
        return c.json({ error: 'invalid_nickname', message: `닉네임은 ${MAX_NICKNAME_LENGTH}자 이하여야 합니다.` }, 400);
      }
      patch.nickname = nickname;
    }

    if (p.avatarUrl !== undefined) {
      if (p.avatarUrl === null) {
        patch.avatarUrl = null;   // 지우기 — 앱이 다시 이니셜 원을 그린다
      } else if (typeof p.avatarUrl !== 'string') {
        return c.json({ error: 'invalid_avatarUrl', message: 'avatarUrl 은 문자열이거나 null 이어야 합니다.' }, 400);
      } else {
        const url = p.avatarUrl.trim();
        // https 만 받는다 — iOS ATS 가 평문 http 를 막아서, 저장은 되고 화면에는 안 뜨는
        //  조용한 실패가 된다(A14 에서 겪은 그 문제).
        if (!url.startsWith('https://') || url.length > MAX_AVATAR_URL_LENGTH) {
          return c.json({
            error: 'invalid_avatarUrl',
            message: `avatarUrl 은 https 로 시작하는 ${MAX_AVATAR_URL_LENGTH}자 이하 URL 이어야 합니다.`,
          }, 400);
        }
        patch.avatarUrl = url;
      }
    }

    if (p.accessFeatures !== undefined) {
      if (!Array.isArray(p.accessFeatures)) {
        return c.json({ error: 'invalid_accessFeatures', message: 'accessFeatures 는 문자열 배열이어야 합니다.' }, 400);
      }
      // ⚠️ **동의 없이는 민감정보를 저장하지 않는다**(050). 장애 관련 정보라 별도 동의가
      //    필요하고, 서버가 받아 놓고 나중에 "동의받았다" 를 증명할 수 없으면 안 된다.
      //    비우는 요청(빈 배열)은 **철회**라 동의가 필요 없다 — 지우는 것까지 막으면
      //    이용자가 자기 정보를 뺄 수 없게 된다.
      const wantsSensitive = p.accessFeatures.length > 0;
      if (wantsSensitive && p.sensitiveConsent !== true) {
        return c.json({
          error: 'sensitive_consent_required',
          message: '접근성 특성은 민감정보라 별도 동의가 필요합니다. sensitiveConsent 를 true 로 함께 보내주세요.',
        }, 400);
      }
      patch.sensitiveConsent = p.sensitiveConsent === true;
      // 값은 검증하지 않는다(앱이 항목을 늘려도 서버 배포 없이 따라가야 한다). 개수와 길이만 막는다.
      patch.features = p.accessFeatures
        .filter((v): v is string => typeof v === 'string' && v.length <= 40)
        .slice(0, MAX_ACCESS_FEATURES);
    }

    // 세 키가 **모두** 없을 때만 거절한다. 예전에는 accessFeatures 하나만 봐서
    //  닉네임만 바꾸려는 요청이 nothing_to_update 로 막혔다(앱 팀이 지적한 그 문제).
    if (Object.keys(patch).length === 0) {
      return c.json({ error: 'nothing_to_update', message: '바꿀 항목이 없습니다.' }, 400);
    }

    await updateProfile(authorId, patch);

    // 갱신된 계정을 그대로 돌려준다 — 앱이 화면을 다시 그릴 때 재조회하지 않아도 되게.
    const view = await loadAuthorView(authorId);
    if (!view) return c.json({ error: 'not_found', message: '계정을 찾을 수 없습니다.' }, 404);
    return c.json(view);
  });

  // ── 계정 삭제(048) ─────────────────────────────────────────────────────────
  //
  //  심사 규칙 5.1.1(v): 계정을 만들 수 있는 앱은 앱 안에서 계정 삭제도 제공해야 한다.
  //
  //  ⚠️ **작성자만 익명화한다 — 콘텐츠는 남긴다**(앱 팀·기획 결정, 048 주석). 함께 쓴 대화가
  //     통째로 사라지면 지운 사람이 아니라 **남은 사람의** 화면이 깨진다.
  //
  //  ⚠️ **되돌릴 수 없다.** 휴지통을 두지 않는다 — 심사가 요구하는 것은 "지울 수 있는가" 이고,
  //     되돌릴 수 있는 삭제는 그 요구를 충족하지 않는다.
  auth.delete('/me', async (c) => {
    const authorId = c.get('authorId');
    if (authorId == null) return c.json({ error: 'login_required', message: '로그인이 필요합니다.' }, 401);

    // 애플 폐기용 토큰을 **지우기 전에** 읽는다.
    const appleToken = (await query<{ refresh_token: string | null }>(
      `select refresh_token from author_identities
        where author_id = $1 and provider = 'apple' and refresh_token is not null`,
      [authorId],
    )).rows[0]?.refresh_token ?? null;

    // ⚠️ 폐기를 **DB 작업보다 먼저** 한다. 순서를 뒤집으면, 커밋 후 폐기가 실패했을 때 토큰이
    //    이미 지워져 다시 시도할 방법이 없다 — 애플 설정에 우리 앱이 영구히 남는다.
    //    반대로 폐기 성공 후 DB 가 실패하면 애플 연결만 끊긴 상태로, 다시 로그인하면 복구된다.
    //    실패해도 삭제는 진행한다(apple-auth.ts 상단) — 폐기 실패로 탈퇴를 막는 것이 더 나쁘다.
    if (appleToken) await revokeApple(appleToken);

    await withTransaction(async (client) => {
      // ① 공유 플랜의 소유권을 넘긴다 — 소유자가 사라지면 플랜이 고아가 된다.
      //    **가장 먼저 합류한 편집자**에게 넘긴다(가장 오래 함께 쓴 사람이다).
      const owned = (await client.query<{ id: string }>(
        'select id from plans where author_id = $1', [authorId],
      )).rows;
      for (const plan of owned) {
        const heir = (await client.query<{ author_id: number }>(
          `select author_id from plan_members
            where plan_id = $1 and author_id <> $2 order by joined_at, author_id limit 1`,
          [plan.id, authorId],
        )).rows[0];
        if (heir) {
          // ⚠️ 소유권은 plans.author_id 로만 표현된다 — plan_members 에는 **편집자만** 있고
          //    role 은 'editor' 만 허용된다(040). 그래서 새 소유자를 멤버 목록에서 뺀다.
          //    남겨 두면 멤버 목록(소유자 ∪ 멤버)에 같은 사람이 두 번 나온다.
          await client.query('update plans set author_id = $2, version = version + 1 where id = $1',
            [plan.id, heir.author_id]);
          await client.query('delete from plan_members where plan_id = $1 and author_id = $2',
            [plan.id, heir.author_id]);
        } else {
          // 남은 사람이 없으면 개인 데이터다 — 볼 사람이 없는 플랜을 남길 이유가 없다.
          await client.query('delete from plans where id = $1', [plan.id]);
        }
      }

      // ② 접근 수단을 끊는다. **신원을 지우는 것이 곧 로그인 차단이다** — 같은 소셜로 다시
      //    로그인하면 (provider, subject) 를 찾지 못해 새 계정이 만들어진다(앱 팀 요청).
      await client.query('delete from author_identities where author_id = $1', [authorId]);
      await client.query('delete from author_sessions where author_id = $1', [authorId]);
      await client.query('delete from author_devices where author_id = $1', [authorId]);
      await client.query('delete from author_email_codes where author_id = $1', [authorId]);
      // ⚠️ 기기 토큰을 지운다 — 남으면 탈퇴한 사람의 기기로 알림이 계속 간다(앱 팀 지적).
      await client.query('delete from device_tokens where author_id = $1', [authorId]);

      // ③ 개인 기록을 지운다. 남의 화면에 보이지 않는 값들이다.
      await client.query('delete from saved_places where author_id = $1', [authorId]);
      await client.query('delete from post_likes where author_id = $1', [authorId]);
      await client.query('delete from review_likes where author_id = $1', [authorId]);
      await client.query('delete from plan_members where author_id = $1', [authorId]);
      await client.query('delete from push_sends where author_id = $1', [authorId]);
      await client.query('delete from blocks where blocker_id = $1 or blocked_id = $1', [authorId]);

      // ④ 좋아요를 지웠으니 후기의 카운터를 실제 값으로 맞춘다 — 안 하면 화면의 좋아요 수가
      //    실제보다 많아진다(댓글 삭제에서 겪은 것과 같은 문제).
      await client.query(
        `update reviews r set like_count = (select count(*) from review_likes l where l.review_id = r.id)
          where r.like_count <> (select count(*) from review_likes l where l.review_id = r.id)`);

      // ⑤ 작성자를 익명화한다. 콘텐츠는 남고 사람만 지워진다.
      await client.query(
        `update authors
            set nickname = $2, email = null, email_verified_at = null, avatar_url = null,
                access_features = '{}', device_id = null, deleted_at = now()
          where id = $1`,
        [authorId, DELETED_NICKNAME]);
      // ⚠️ reviews.author_nm 은 닉네임 사본이다(레거시 표시용). 여기도 바꾸지 않으면 후기
      //    목록에 지운 사람의 닉네임이 그대로 남는다.
      await client.query('update reviews set author_nm = $2 where author_id = $1',
        [authorId, DELETED_NICKNAME]);
    });

    return c.body(null, 204);
  });

  return auth;
}
