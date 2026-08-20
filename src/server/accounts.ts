// 계정·기기 바인딩 — 익명 기기와 로그인 계정을 잇는 규칙을 한곳에 모은다.
//
// 이 모듈은 **인증 방식을 모른다.** 애플·구글·카카오 토큰을 어디서 어떻게 검증했든,
// 검증이 끝난 신원(VerifiedIdentity)만 받는다. 그래서 관리형 서비스(Supabase 등)를 쓰든
// 직접 JWKS 검증을 하든 아래 규칙은 그대로다 — 프로바이더 선택과 이 파일은 독립이다.
//
// 규칙 요약(024_accounts.sql 의 주석과 짝):
//   · 익명       — device_id → author_devices → authors (계정 정보 없음)
//   · 로그인     — (provider, subject) 로 계정을 찾고, 이 기기의 익명 데이터를 그 계정으로 병합
//   · 로그아웃   — 기기 바인딩만 끊는다. 다음 익명 활동은 **새 빈 계정**을 만든다.
import type pg from 'pg';
import { query, withTransaction } from '../db';

export type Provider = 'apple' | 'google' | 'kakao' | 'email';

/** 토큰 검증이 **이미 끝난** 신원. 검증되지 않은 값을 여기에 넣으면 안 된다. */
export type VerifiedIdentity = {
  provider: Provider;
  /** 프로바이더가 주는 고유 사용자 ID(OIDC sub). 이메일이 아니라 이 값이 계정의 키다. */
  subject: string;
  email?: string | null;
};

export type SignInResult = {
  authorId: number;
  /** 외부에 노출해도 되는 식별자. authors.id(bigserial)는 응답에 넣지 않는다. */
  uuid: string;
  nickname: string;
  /** 이 기기의 익명 데이터를 기존 계정으로 합쳤는지 — 앱이 "가져왔습니다" 안내에 쓸 수 있다. */
  merged: boolean;
  /** 이번 로그인으로 계정이 새로 만들어졌는지(= 가입) */
  created: boolean;
  email: string | null;
  emailVerified: boolean;
};

// 새 계정에 닉네임이 없을 때의 값. authors.nickname 이 not null 이라 무언가는 있어야 하고,
// 소셜 프로바이더가 이름을 항상 주지는 않는다(애플은 최초 인가 때만, 그마저 생략 가능).
const FALLBACK_NICKNAME = '여행자';

/**
 * 이메일을 신원 키로 쓸 수 있는 형태로 만든다.
 * (provider, subject) 유니크가 "한 이메일에 계정 하나"를 보장하는데, 소문자화하지 않으면
 * Foo@x.com 과 foo@x.com 이 서로 다른 계정이 되어 그 보장이 깨진다.
 * ⚠️ 이메일을 쓰거나 찾는 모든 경로가 이 함수를 통과해야 한다.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** 이메일 신원 조회 — 로그인 시 비밀번호를 대조하기 위한 것. 없으면 null. */
export async function findEmailIdentity(
  email: string,
): Promise<{ authorId: number; passwordHash: string | null } | null> {
  const row = (await query<{ author_id: number; password_hash: string | null }>(
    "select author_id, password_hash from author_identities where provider = 'email' and subject = $1",
    [normalizeEmail(email)],
  )).rows[0];
  return row ? { authorId: row.author_id, passwordHash: row.password_hash } : null;
}

/** 기기에 묶인 계정. author_devices 가 정본이고 authors.device_id 는 구버전 폴백이다. */
export async function findAuthorByDevice(deviceId: string): Promise<number | null> {
  const row = (await query<{ author_id: number }>(
    `select author_id from author_devices where device_id = $1
      union all
     select id from authors where device_id = $1
      limit 1`,
    [deviceId],
  )).rows[0];
  return row?.author_id ?? null;
}

/**
 * 기기를 계정에 묶는다(이중 기록의 author_devices 쪽).
 *
 * 호출부의 **트랜잭션 안에서** 부르도록 client 를 받는다. 후기 작성·플랜 저장은 이미
 * 자기 트랜잭션에서 author 를 만들고 본문을 쓰는데, 여기서 별도 트랜잭션을 열면
 * 본문 저장이 실패해도 바인딩만 남아 둘이 어긋난다.
 */
export async function bindDevice(
  client: pg.PoolClient,
  deviceId: string,
  authorId: number,
): Promise<void> {
  await touchDevice(client, deviceId, authorId);
}

/**
 * 검증된 신원으로 로그인/가입하고, 이 기기를 그 계정에 묶는다.
 *
 * 병합 규칙 — "가입했더니 내 플랜이 사라졌다"를 막는 것이 이 함수의 목적이다.
 *   ① 신원이 처음 보는 것이고 이 기기가 익명 계정에 묶여 있다
 *        → 그 익명 계정을 **승격**한다. 데이터 이동이 없으니 가장 안전하다.
 *   ② 신원이 처음 보는 것이고 이 기기에 계정이 없다        → 새 계정을 만든다.
 *   ③ 신원에 계정이 있고 이 기기가 **익명** 계정에 묶여 있다
 *        → 익명 계정의 후기·플랜·댓글을 계정으로 옮기고 익명 행을 지운다.
 *   ④ 신원에 계정이 있고 이 기기가 **다른 계정**(이미 로그인한 적 있는)에 묶여 있다
 *        → 병합하지 않고 바인딩만 옮긴다. 남의 계정 데이터를 흡수하는 건 되돌릴 수 없다.
 */
export async function signIn(params: {
  identity: VerifiedIdentity;
  deviceId: string;
  nickname?: string;
  /** 이메일 가입에서만 쓴다. 신원을 **처음 만들 때만** 반영된다(로그인은 비밀번호를 덮지 않는다). */
  passwordHash?: string | null;
}): Promise<SignInResult> {
  const { identity, deviceId } = params;
  const nickname = (params.nickname ?? '').trim();

  return withTransaction(async (client) => {
    const existing = (await client.query<{ author_id: number }>(
      'select author_id from author_identities where provider = $1 and subject = $2',
      [identity.provider, identity.subject],
    )).rows[0];

    const bound = deviceId ? await findBoundAuthor(client, deviceId) : null;
    let authorId: number;
    let merged = false;
    let created = false;

    if (existing) {
      authorId = existing.author_id;
      if (bound != null && bound !== authorId) {
        // ③/④ — 익명일 때만 합친다.
        if (await isAnonymous(client, bound)) {
          await moveOwnedRows(client, bound, authorId);
          await client.query('delete from authors where id = $1', [bound]);
          merged = true;
        }
      }
      await client.query(
        `update author_identities set email = coalesce($3, email), updated_at = now()
          where provider = $1 and subject = $2`,
        [identity.provider, identity.subject, identity.email ?? null],
      );
    } else if (bound != null && await isAnonymous(client, bound)) {
      authorId = bound; // ① 승격 — 데이터가 제자리에 그대로 남는다.
      created = true;
    } else {
      // ② 새 계정. device_id 는 넣지 않는다 — 바인딩은 author_devices 가 맡는다.
      authorId = (await client.query<{ id: number }>(
        'insert into authors (nickname) values ($1) returning id',
        [nickname || FALLBACK_NICKNAME],
      )).rows[0]!.id;
      created = true;
    }

    if (!existing) {
      await client.query(
        `insert into author_identities (author_id, provider, subject, email, password_hash)
         values ($1, $2, $3, $4, $5)
         on conflict (provider, subject) do update
           set author_id = excluded.author_id, email = coalesce(excluded.email, author_identities.email),
               updated_at = now()`,
        [authorId, identity.provider, identity.subject, identity.email ?? null, params.passwordHash ?? null],
      );
    }

    // 계정 대표 이메일은 비어 있을 때만 채운다. 사용자가 직접 바꾼 주소를 소셜 응답이
    // 덮어쓰면 안 되고, 애플처럼 최초 1회만 주는 프로바이더도 있어 null 로 지워질 위험이 있다.
    if (identity.email) {
      await client.query(
        'update authors set email = coalesce(email, $2) where id = $1',
        [authorId, identity.email],
      );
    }
    if (nickname) {
      await client.query('update authors set nickname = $2 where id = $1', [authorId, nickname]);
    }
    if (deviceId) await touchDevice(client, deviceId, authorId);

    const row = (await client.query<{ uuid: string; nickname: string; email: string | null; verified: Date | null }>(
      'select uuid, nickname, email, email_verified_at as verified from authors where id = $1', [authorId],
    )).rows[0]!;
    return {
      authorId, uuid: row.uuid, nickname: row.nickname, merged, created,
      email: row.email, emailVerified: row.verified != null,
    };
  });
}

/**
 * 로그아웃 — 기기 바인딩만 끊는다. 계정과 그 데이터는 그대로 남고, 다시 로그인하면 돌아온다.
 * authors.device_id 까지 비우는 것이 중요하다. 남겨 두면 구버전 폴백 경로가 방금 끊은
 * 바인딩을 되살려, 로그아웃한 기기에 계정 데이터가 다시 보인다.
 */
export async function signOutDevice(deviceId: string): Promise<void> {
  await withTransaction(async (client) => {
    await client.query('delete from author_devices where device_id = $1', [deviceId]);
    await client.query('update authors set device_id = null where device_id = $1', [deviceId]);
  });
}

// ── 내부 ─────────────────────────────────────────────────────────────────────
async function findBoundAuthor(client: pg.PoolClient, deviceId: string): Promise<number | null> {
  const row = (await client.query<{ author_id: number }>(
    `select author_id from author_devices where device_id = $1
      union all
     select id from authors where device_id = $1
      limit 1`,
    [deviceId],
  )).rows[0];
  return row?.author_id ?? null;
}

async function touchDevice(client: pg.PoolClient, deviceId: string, authorId: number): Promise<void> {
  await client.query(
    `insert into author_devices (device_id, author_id) values ($1, $2)
       on conflict (device_id) do update set author_id = excluded.author_id, last_seen_at = now()`,
    [deviceId, authorId],
  );
}

/** 계정 정보(소셜 신원)가 하나도 없는 = 익명 author 인가. 병합해도 되는지의 기준이다. */
async function isAnonymous(client: pg.PoolClient, authorId: number): Promise<boolean> {
  const row = (await client.query<{ n: number }>(
    'select count(*)::int n from author_identities where author_id = $1', [authorId],
  )).rows[0]!;
  return row.n === 0;
}

/**
 * 익명 계정이 가진 것을 계정으로 옮긴다.
 *
 * ⚠️ **authors 를 참조하는 테이블을 새로 만들면 반드시 여기에 추가할 것.**
 *    빠뜨리면 호출부가 옮기고 남은 익명 행을 지울 때 on delete cascade 로 **조용히 함께 삭제된다.**
 *    (실제로 025~027 의 저장·게시글·좋아요가 그렇게 빠져 있었다)
 *
 * reviews.author_nm 은 건드리지 않는다 — 작성 시점의 표시 이름 스냅샷이고, 016 이 그 값을
 * 키로 UPDATE 하기 때문에 바꾸면 다른 마이그레이션이 깨진다.
 */
async function moveOwnedRows(client: pg.PoolClient, from: number, to: number): Promise<void> {
  // ① author_id 가 유일성 제약에 안 걸리는 테이블 — 그냥 넘긴다.
  for (const table of ['reviews', 'plans', 'review_comments', 'posts', 'post_comments']) {
    await client.query(`update ${table} set author_id = $2 where author_id = $1`, [from, to]);
  }

  // ② author_id 가 PK 의 일부인 테이블 — 같은 대상을 양쪽 계정이 이미 갖고 있으면 PK 가 충돌한다.
  //    (폰과 태블릿에서 같은 장소를 각각 저장해 둔 경우처럼 실제로 흔하다)
  //    그대로 update 하면 병합 트랜잭션 전체가 실패하므로, 계정에 없는 것만 옮기고
  //    이미 갖고 있어 옮길 수 없는 중복은 버린다 — 어차피 결과가 같다(저장했다/눌렀다).
  await moveUnique(client, 'saved_places', 'content_id', from, to);
  await moveUnique(client, 'post_likes', 'post_id', from, to);
}

/** (author_id, key) 가 PK 인 테이블을 옮긴다. 중복은 옮기지 않고 버린다. */
async function moveUnique(
  client: pg.PoolClient,
  table: 'saved_places' | 'post_likes',
  key: 'content_id' | 'post_id',
  from: number,
  to: number,
): Promise<void> {
  await client.query(
    `update ${table} s set author_id = $2
      where s.author_id = $1
        and not exists (select 1 from ${table} t where t.author_id = $2 and t.${key} = s.${key})`,
    [from, to],
  );
  await client.query(`delete from ${table} where author_id = $1`, [from]);
}
