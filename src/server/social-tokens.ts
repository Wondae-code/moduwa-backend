// 소셜 로그인 토큰 검증 — 애플·구글이 준 ID 토큰이 진짜인지, 그리고 **우리 앱에 발급된
// 것인지** 확인한다. 이 파일만 프로바이더를 안다(mailer.ts 가 메일 provider 를 혼자 아는 것과 같다).
//
// 검증이 끝나면 accounts.signIn 이 이메일 로그인과 **똑같은 길**을 탄다 —
// (provider, subject) 로 계정을 찾고, 없으면 만들고, 기기를 묶고, 세션을 낸다.
//
// ⚠️ **audience(aud) 검사가 이 파일의 핵심이다.** 서명만 확인하고 aud 를 보지 않으면,
//    공격자가 *자기* 앱에 발급된 구글 토큰을 우리 서버에 내밀어 그 사람으로 로그인할 수 있다
//    (token substitution). 구글·애플의 서명은 남의 앱 토큰에도 똑같이 유효하다.
//    그래서 클라이언트 ID 가 설정되지 않았으면 **아예 거부한다**(fail closed) — 빈 허용목록을
//    "전부 통과"로 두면 설정을 깜빡한 배포가 그 순간 계정 탈취 경로가 된다.
//
// ⚠️ 이메일로 계정을 잇지 않는다. provider 가 이메일 소유를 검증하지 않는 경우도 있어,
//    같은 이메일이라는 이유로 기존 계정에 붙이면 그것만으로 남의 계정을 가져갈 수 있다.
//    계정을 정하는 것은 언제나 (provider, subject) 다.
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from '../config';

/** 검증을 통과한 소셜 신원. `email` 은 없을 수 있다(애플은 최초 1회만 준다). */
export type SocialProfile = {
  /** provider 안에서 이 사람을 가리키는 불변 식별자(`sub`). 계정의 축이다. */
  subject: string;
  email: string | null;
  /** provider 가 이메일 소유를 확인했다고 말하는지. 우리 계정의 인증 표시에 쓴다. */
  emailVerified: boolean;
  /** 표시 이름 힌트. 있으면 **새 계정의 초기 닉네임**으로만 쓴다. */
  name: string | null;
};

/** 설정이 없어 검증 자체를 할 수 없다 — 라우트가 503 으로 답한다(401 이 아니다). */
export class SocialNotConfiguredError extends Error {}
/** 토큰이 위조·만료·다른 앱 것이다. 라우트가 401 로 답한다. */
export class SocialTokenError extends Error {}

// JWKS 는 프로바이더가 키를 돌려도 따라가야 한다. jose 의 remote set 이 캐시와 재조회를
//  맡는다 — 요청마다 받아오면 로그인이 남의 서버 응답 시간에 묶인다.
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const appleKeys = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

// 구글은 두 형태를 모두 발급해 왔다. 둘 다 받는다.
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const APPLE_ISSUER = 'https://appleid.apple.com';

/**
 * `email_verified` 는 불리언으로 오기도 하고 문자열 `"true"` 로 오기도 한다(애플).
 * 문자열을 그대로 truthy 로 보면 `"false"` 도 참이 되므로 값을 직접 비교한다.
 */
function claimIsTrue(value: unknown): boolean {
  return value === true || value === 'true';
}

function claimString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function verify(
  idToken: string,
  keys: ReturnType<typeof createRemoteJWKSet>,
  issuer: string | string[],
  audiences: string[],
  provider: string,
): Promise<SocialProfile> {
  if (audiences.length === 0) {
    throw new SocialNotConfiguredError(`${provider} 클라이언트 ID 가 설정되지 않았습니다.`);
  }
  if (!idToken) throw new SocialTokenError('토큰이 없습니다.');

  let payload: Record<string, unknown>;
  try {
    // jose 가 서명·iss·aud·exp·nbf 를 함께 본다. audience 배열은 "이 중 하나와 같으면 통과"다.
    ({ payload } = await jwtVerify(idToken, keys, { issuer, audience: audiences }) as {
      payload: Record<string, unknown>;
    });
  } catch (error) {
    // 실패 사유를 클라이언트에 흘리지 않는다 — 서명 실패와 만료를 구분해 주면 공격자가
    //  무엇을 고쳐야 하는지 알게 된다. 서버 로그에는 남긴다.
    console.warn(`[social] ${provider} 토큰 검증 실패:`, (error as Error).message);
    throw new SocialTokenError('토큰을 확인할 수 없습니다.');
  }

  const subject = claimString(payload.sub);
  if (!subject) throw new SocialTokenError('토큰에 사용자 식별자가 없습니다.');

  const email = claimString(payload.email);
  return {
    subject,
    email,
    // 이메일이 없으면 인증 여부를 말할 것도 없다.
    emailVerified: email != null && claimIsTrue(payload.email_verified),
    name: claimString(payload.name),
  };
}

/**
 * 구글 ID 토큰 검증.
 *
 * `aud` 는 **iOS 클라이언트 ID** 다. 앱이 ASWebAuthenticationSession + PKCE 로 받은
 * id_token 을 그대로 보내고, 그 토큰의 aud 는 인증 요청에 쓴 client_id 다.
 */
export function verifyGoogleIdToken(idToken: string): Promise<SocialProfile> {
  return verify(idToken, googleKeys, GOOGLE_ISSUERS, config.social.googleAudiences, 'google');
}

/**
 * 애플 ID 토큰 검증.
 *
 * 네이티브 Sign in with Apple 의 `aud` 는 **앱의 번들 ID** 다(웹 플로우는 Service ID).
 * 이름은 토큰에 없다 — 애플은 최초 인증 응답에서만 `fullName` 을 주므로, 앱이 그때
 * 받은 이름을 요청 본문의 `nickname` 으로 함께 보낸다.
 */
export function verifyAppleIdToken(idToken: string): Promise<SocialProfile> {
  return verify(idToken, appleKeys, APPLE_ISSUER, config.social.appleAudiences, 'apple');
}
