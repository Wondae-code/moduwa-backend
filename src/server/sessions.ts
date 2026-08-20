// 로그인 세션 — 토큰 발급·검증·폐기. 028_sessions.sql 과 짝이다.
//
// 토큰은 32바이트 난수이고, DB 에는 **sha256 해시만** 넣는다. 원문은 발급 응답에 한 번
// 나가고 서버 어디에도 남지 않는다 — DB 가 새도 그것만으로는 남의 세션이 될 수 없다.
//
// 비밀번호(password.ts)와 달리 느린 해시를 쓰지 않는 이유: 토큰은 256비트 난수라
// 사전 공격 대상이 아니다. 여기서 scrypt 를 쓰면 모든 요청마다 수십 ms 를 태우게 된다.
import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { config } from '../config';
import { pool, query } from '../db';

/** 클라이언트가 보내는 헤더. Authorization 은 이미 API 키가 쓰고 있어 겹칠 수 없다. */
export const SESSION_HEADER = 'x-session-token';

export type IssuedSession = { token: string; expiresAt: string };

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * 세션을 발급한다.
 * 로그인 트랜잭션 안에서 부르고 싶을 때를 위해 client 를 받는다(생략하면 풀에서 바로).
 */
export async function issueSession(
  authorId: number,
  deviceId: string | null,
  client?: pg.PoolClient,
): Promise<IssuedSession> {
  // base64url 43자. 추측할 수 없어야 하므로 randomUUID(122비트)가 아니라 256비트를 쓴다.
  const token = randomBytes(32).toString('base64url');
  const run = client ?? pool;
  const row = (await run.query<{ expires_at: Date }>(
    `insert into author_sessions (author_id, token_hash, device_id, expires_at)
     values ($1, $2, $3, now() + make_interval(days => $4))
     returning expires_at`,
    [authorId, hashToken(token), deviceId || null, config.auth.sessionDays],
  )).rows[0]!;
  return { token, expiresAt: row.expires_at.toISOString() };
}

/**
 * 토큰을 검증하고 만료를 뒤로 민다. 유효하지 않으면 null.
 *
 * 검증과 갱신을 **한 UPDATE 로** 처리한다. select 후 update 로 나누면 왕복이 두 번이고,
 * 그 사이에 폐기된 세션이 통과하는 창이 생긴다.
 */
export async function resolveSession(
  token: string,
): Promise<{ authorId: number; sessionId: string } | null> {
  if (!token) return null;
  const row = (await query<{ author_id: number; id: string }>(
    `update author_sessions
        set last_used_at = now(),
            expires_at   = now() + make_interval(days => $2)
      where token_hash = $1
        and revoked_at is null
        and expires_at > now()
      returning author_id, id`,
    [hashToken(token), config.auth.sessionDays],
  )).rows[0];
  return row ? { authorId: row.author_id, sessionId: row.id } : null;
}

/** 이 토큰 하나만 끊는다(= 이 기기 로그아웃). 이미 없거나 폐기됐어도 조용히 지나간다. */
export async function revokeSession(token: string): Promise<void> {
  if (!token) return;
  await query(
    'update author_sessions set revoked_at = now() where token_hash = $1 and revoked_at is null',
    [hashToken(token)],
  );
}

/**
 * 이 기기에서 난 세션을 전부 끊는다.
 * 로그아웃은 토큰 폐기 + 기기 바인딩 해제(accounts.signOutDevice)가 짝이다. 토큰만 끊고
 * 바인딩을 두면 그 기기의 다음 익명 요청이 여전히 계정으로 해석된다.
 */
export async function revokeDeviceSessions(deviceId: string): Promise<void> {
  if (!deviceId) return;
  await query(
    'update author_sessions set revoked_at = now() where device_id = $1 and revoked_at is null',
    [deviceId],
  );
}

/** 이 계정의 모든 세션을 끊는다(비밀번호 변경·기기 분실). except 로 지금 쓰는 세션만 남길 수 있다. */
export async function revokeAuthorSessions(authorId: number, exceptToken?: string): Promise<void> {
  await query(
    `update author_sessions set revoked_at = now()
      where author_id = $1 and revoked_at is null
        and ($2::text is null or token_hash <> $2)`,
    [authorId, exceptToken ? hashToken(exceptToken) : null],
  );
}
