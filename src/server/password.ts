// 비밀번호 해시 — node:crypto 의 scrypt. 외부 의존성 없음.
//
// bcrypt·argon2 패키지를 붙이지 않는 이유:
//  · 둘 다 네이티브 빌드가 필요해 Docker/Railway 이미지에서 깨지기 쉽다.
//  · scrypt 는 Node 표준이고 메모리 하드(memory-hard)라 GPU 대량 대입에 강하다.
//  · dashboard-auth.ts 가 이미 같은 이유로 서명 쿠키를 직접 구현해 두었다.
//
// ⚠️ 저장 형식에 **알고리즘 파라미터를 함께** 담는다: scrypt$N$r$p$salt$hash
//    나중에 N 을 올려도 기존 비밀번호가 저장된 파라미터로 그대로 검증된다.
//    (파라미터를 코드 상수로만 두면 강도를 올리는 순간 전원이 로그인 불가가 된다)
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// N=32768, r=8 → 해시 1회당 메모리 128*N*r = 32MB, 시간 수십~100ms 대.
//  로그인은 초당 수십 건도 안 되는 요청이라 이 정도 비용이 맞다.
//  maxmem 을 명시하지 않으면 Node 기본값(32MB)에 걸려 실패하므로 여유를 둔다.
const N = 32768;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAXMEM = 128 * N * R * 2;

// 비밀번호 정책. 상한을 두는 이유는 아주 긴 입력으로 CPU 를 태우는 것을 막기 위함이다.
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/** 저장할 문자열을 만든다. 같은 비밀번호라도 매번 다른 값이 나온다(솔트). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/**
 * 저장된 값과 비교한다. 형식이 깨졌거나 알 수 없는 알고리즘이면 **던지지 않고 false** 다 —
 * 로그인 경로에서 예외가 나면 500 이 되어 "이 계정은 뭔가 다르다"를 공격자에게 알려준다.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  // 저장값이 오염돼 터무니없는 N 이 들어오면 메모리를 통째로 먹는다. 상한을 건다.
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (n < 1024 || n > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return false;

  const salt = Buffer.from(parts[4]!, 'base64url');
  const expected = Buffer.from(parts[5]!, 'base64url');
  if (salt.length === 0 || expected.length !== KEYLEN) return false;

  try {
    const actual = await derive(password, salt, n, r, p);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// 존재하지 않는 이메일로 로그인을 시도했을 때 쓸 더미 해시.
//  DB 조회에서 바로 실패를 돌려주면 응답이 눈에 띄게 빨라, 그 시간차만으로
//  "가입된 이메일인지"를 알아낼 수 있다(user enumeration). 같은 비용을 태워 준다.
const DUMMY_HASH = `scrypt$${N}$${R}$${P}$${randomBytes(16).toString('base64url')}$${randomBytes(KEYLEN).toString('base64url')}`;

/** 계정이 없을 때도 같은 시간을 쓰게 한다. 항상 false 를 돌려준다. */
export async function burnVerifyTime(password: string): Promise<false> {
  await verifyPassword(password, DUMMY_HASH);
  return false;
}

/** 정책 위반 사유. 통과면 null. */
export function passwordPolicyError(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `비밀번호는 ${MAX_PASSWORD_LENGTH}자 이하여야 합니다.`;
  }
  return null;
}
