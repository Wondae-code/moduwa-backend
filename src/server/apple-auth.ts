// Sign in with Apple — 코드 교환과 토큰 폐기. 이 파일만 애플의 토큰 엔드포인트를 안다.
//
// ── 왜 필요한가
//  애플 로그인을 제공하는 앱은 **계정 삭제 시 애플에 토큰 폐기를 요청해야 한다**(심사 규칙).
//  폐기 요청에는 애플이 로그인 때 준 refresh token 이 필요하고, 그 토큰은 ID 토큰이 아니라
//  authorization code 를 교환해서 받는다. 그래서 두 함수가 한 쌍이다:
//   - exchangeCode : 로그인 때 code → refresh token (저장해 둔다)
//   - revoke       : 계정 삭제 때 refresh token → 폐기
//
// ⚠️ **APNs 키와 다른 .p8 이다.** 용도가 "Sign in with Apple" 인 별도 키다. APNs 키로 서명하면
//    애플이 invalid_client 를 준다. 키가 없으면 두 함수는 조용히 실패하고(false) 호출부는
//    진행한다 — 폐기를 못 했다고 계정 삭제를 막는 것이 더 나쁘다.
//
// ⚠️ ES256 은 DER 이 아니라 P1363(r||s) 형식을 요구한다 — push.ts 와 같은 함정이다.
import { createSign } from 'node:crypto';
import { config } from '../config';

const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
const APPLE_REVOKE_URL = 'https://appleid.apple.com/auth/revoke';

/** client_secret 은 최대 6개월까지 유효하지만, 짧게 잡아 캐시 없이 매번 만든다(호출이 드물다). */
const SECRET_TTL_SEC = 300;

const base64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

/** 애플이 요구하는 client_secret(ES256 서명 JWT). 키가 없으면 null. */
function clientSecret(): string | null {
  const { keyP8Base64, keyId, teamId, clientId } = config.appleAuth;
  if (!keyP8Base64 || !keyId || !teamId || !clientId) return null;

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const payload = base64url(JSON.stringify({
    iss: teamId, iat: now, exp: now + SECRET_TTL_SEC,
    // ⚠️ aud 는 애플 자신이고 sub 는 우리 앱이다. 둘을 바꿔 넣으면 invalid_client 다.
    aud: 'https://appleid.apple.com', sub: clientId,
  }));
  const signer = createSign('SHA256');
  signer.update(`${header}.${payload}`);
  const pem = Buffer.from(keyP8Base64, 'base64').toString('utf8');
  const sig = signer.sign({ key: pem, dsaEncoding: 'ieee-p1363' });
  return `${header}.${payload}.${base64url(sig)}`;
}

export function isConfigured(): boolean {
  return clientSecret() !== null;
}

/**
 * 로그인 때 받은 authorization code 를 refresh token 으로 바꾼다.
 *
 * 실패하면 null 이다 — **로그인을 막지 않는다.** ID 토큰 검증은 이미 끝났고, refresh token 은
 * 나중의 계정 삭제에만 쓰인다. 없으면 그때 폐기를 건너뛴다.
 */
export async function exchangeCode(code: string): Promise<string | null> {
  const secret = clientSecret();
  if (!secret) return null;
  try {
    const res = await fetch(APPLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.appleAuth.clientId,
        client_secret: secret,
        code,
        grant_type: 'authorization_code',
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      console.warn(`[apple] 코드 교환 실패 ${res.status}: ${text.slice(0, 200)}`);
      return null;
    }
    const token = (JSON.parse(text) as { refresh_token?: string }).refresh_token;
    return token || null;
  } catch (err) {
    console.warn('[apple] 코드 교환 예외:', err);
    return null;
  }
}

/**
 * 계정 삭제 시 애플 쪽 연결을 끊는다. 성공 여부를 돌려주지만 호출부는 이것으로 삭제를 막지 않는다.
 *
 * ⚠️ 폐기하지 않으면 사용자가 앱을 지운 뒤에도 애플 설정에 우리 앱이 남는다. 심사에서 지적하는
 *    항목이라 "조용히 안 하기" 는 답이 아니다 — 실패는 로그로 남긴다.
 */
export async function revoke(token: string): Promise<boolean> {
  const secret = clientSecret();
  if (!secret) {
    console.warn('[apple] 폐기 건너뜀 — Sign in with Apple 키가 설정되지 않았다');
    return false;
  }
  try {
    const res = await fetch(APPLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.appleAuth.clientId,
        client_secret: secret,
        token,
        token_type_hint: 'refresh_token',
      }),
    });
    // 애플은 성공 시 200 에 빈 본문을 준다.
    if (res.ok) return true;
    console.warn(`[apple] 폐기 실패 ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return false;
  } catch (err) {
    console.warn('[apple] 폐기 예외:', err);
    return false;
  }
}
