// 계정·기기 바인딩 — 익명 기기와 로그인 계정을 잇는 규칙을 한곳에 모은다.
//
// 이 모듈은 **인증 방식을 모른다.** 애플·구글·카카오 토큰을 어디서 어떻게 검증했든,
// 검증이 끝난 신원(VerifiedIdentity)만 받는다. 그래서 관리형 서비스(Supabase 등)를 쓰든
// 직접 JWKS 검증을 하든 아래 규칙은 그대로다 — 프로바이더 선택과 이 파일은 독립이다.
//
// 규칙 요약(030 이후):
//   · authors 행은 **로그인 계정에만** 생긴다. 익명 기기가 계정을 만드는 경로는 없다.
//   · 로그인   — (provider, subject) 로 계정을 찾고, 없으면 만든다. 이 기기를 그 계정에 묶는다.
//   · 로그아웃 — 기기 바인딩만 끊는다. 계정과 데이터는 남고 다시 로그인하면 돌아온다.
//
// ⚠️ **병합(익명 데이터 이관)은 없다.** 024~029 에는 "deviceId 로 익명 계정을 찾아 승격하거나
//    그 데이터를 계정으로 옮기는" 경로가 있었는데, deviceId 소유를 증명할 방법이 없어서
//    **남의 deviceId 를 실어 가입하면 그 계정을 가져갈 수 있었다.** 쓰기를 로그인 필수로 바꿔
//    익명 계정이 아예 생기지 않게 되었으므로, 가져갈 대상과 함께 그 경로를 제거했다.
//    온보딩 프로필은 앱 로컬에 있다가 가입 요청에 실려 온다(accessFeatures).
import type pg from 'pg';
import { query, withTransaction } from '../db';

export type Provider = 'apple' | 'google' | 'kakao' | 'naver' | 'email';

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
  /** 이번 로그인으로 계정이 새로 만들어졌는지(= 가입). 앱이 온보딩 완료 처리에 쓴다. */
  created: boolean;
  email: string | null;
  emailVerified: boolean;
  /** 온보딩에서 고른 무장애 항목(030). 앱이 로컬 값과 맞추는 데 쓴다. */
  accessFeatures: string[];
  onboarded: boolean;
  /** 프로필 사진(042). 로그인 직후에도 앱이 아바타를 바로 그릴 수 있게 함께 준다. */
  avatarUrl: string | null;
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
 *
 * ⚠️ 이 함수는 **기기의 소유자를 바꾸지 않는다.** 이미 다른 계정에 묶인 기기면 아무 일도
 *    일어나지 않는다(touchDevice 주석 참고). 소유자 변경은 signIn 만 할 수 있다.
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
 * 하는 일이 단순하다 — (provider, subject) 로 계정을 찾고, 없으면 만든다.
 * 예전에는 여기서 deviceId 로 익명 계정을 찾아 승격·병합했는데, 그 경로가 곧
 * "deviceId 를 아는 사람이 그 계정을 가져가는" 구멍이었다(파일 상단 주석 참고).
 *
 * 그래서 **deviceId 는 신원 근거가 아니다.** 여기서의 용도는 "이 계정이 지금 이 기기를
 * 쓴다"는 기록 하나뿐이고, 그 기록으로 남의 데이터에 닿을 수 있는 경로는 없다.
 */
export async function signIn(params: {
  identity: VerifiedIdentity;
  deviceId: string;
  /** **새 계정의 초기 닉네임.** 이미 있는 계정에는 반영하지 않는다(아래 주석 참고). */
  nickname?: string;
  /** 이메일 가입에서만 쓴다. 신원을 **처음 만들 때만** 반영된다(로그인은 비밀번호를 덮지 않는다). */
  passwordHash?: string | null;
  /**
   * 온보딩에서 고른 무장애 항목. 앱 로컬에 있던 값이 가입 요청에 실려 온다.
   * ⚠️ **가입할 때만** 반영한다 — 로그인 때도 덮으면, 앱을 지웠다 깐 기기로 로그인하는 것만으로
   *    사용자가 나중에 직접 고친 프로필이 온보딩 기본값으로 되돌아간다.
   */
  accessFeatures?: string[];
}): Promise<SignInResult> {
  const { identity, deviceId } = params;
  const nickname = (params.nickname ?? '').trim();

  return withTransaction(async (client) => {
    const existing = (await client.query<{ author_id: number }>(
      'select author_id from author_identities where provider = $1 and subject = $2',
      [identity.provider, identity.subject],
    )).rows[0];

    let authorId: number;
    let created = false;

    if (existing) {
      authorId = existing.author_id;
      await client.query(
        `update author_identities set email = coalesce($3, email), updated_at = now()
          where provider = $1 and subject = $2`,
        [identity.provider, identity.subject, identity.email ?? null],
      );
    } else {
      // 새 계정. authors.device_id 는 채우지 않는다 — 바인딩은 author_devices 가 맡는다.
      //  onboarded_at 은 accessFeatures 가 실려 왔을 때만 찍는다. 빈 배열만으로는
      //  "아무것도 고르지 않았다"와 "온보딩을 안 했다"를 구분할 수 없다(030 주석).
      authorId = (await client.query<{ id: number }>(
        `insert into authors (nickname, access_features, onboarded_at)
         values ($1, $2, case when $3::boolean then now() else null end)
         returning id`,
        [nickname || FALLBACK_NICKNAME, params.accessFeatures ?? [], params.accessFeatures != null],
      )).rows[0]!.id;
      created = true;

      // on conflict 를 쓰지 않는다 — 충돌은 "그 사이 같은 신원이 만들어졌다"는 뜻이고,
      //  그때 author_id 를 덮어쓰면 뒤에 온 요청이 앞 요청의 신원을 가져간다.
      //  유니크 위반으로 트랜잭션을 되돌리는 것이 맞다(호출부가 재시도하거나 409 를 낸다).
      await client.query(
        `insert into author_identities (author_id, provider, subject, email, password_hash)
         values ($1, $2, $3, $4, $5)`,
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
    // ⚠️ 기존 계정의 닉네임은 **건드리지 않는다.** 여기서 덮으면 소셜로 로그인할 때마다
    //    프로바이더가 준 이름이 사용자가 직접 고친 닉네임을 되돌린다(accessFeatures 와 같은 함정).
    //    새 계정의 초기 닉네임은 위 insert 가 이미 정했다.
    // 로그인은 기기의 소유자가 바뀌는 유일한 지점이다 — 여기서만 rebind 를 허용한다.
    if (deviceId) await touchDevice(client, deviceId, authorId, true);

    const row = (await client.query<{
      uuid: string; nickname: string; email: string | null; verified: Date | null;
      access_features: string[]; onboarded_at: Date | null; avatar_url: string | null;
    }>(
      `select uuid, nickname, email, email_verified_at as verified, access_features, onboarded_at,
              avatar_url
         from authors where id = $1`,
      [authorId],
    )).rows[0]!;
    return {
      authorId, uuid: row.uuid, nickname: row.nickname, created,
      email: row.email, emailVerified: row.verified != null,
      accessFeatures: row.access_features, onboarded: row.onboarded_at != null,
      avatarUrl: row.avatar_url,
    };
  });
}

/** 이메일 신원의 비밀번호를 바꾼다(재설정). provider='email' 행만 대상이다. */
export async function setEmailPassword(authorId: number, passwordHash: string): Promise<void> {
  await query(
    `update author_identities set password_hash = $2, updated_at = now()
      where author_id = $1 and provider = 'email'`,
    [authorId, passwordHash],
  );
}

/**
 * 무장애 프로필을 바꾼다(내 정보 화면).
 *
 * 가입 때 한 번 정하고 끝낼 값이 아니다 — 다치거나 회복하거나 아이가 크면 필요한 것이 바뀐다.
 * 온보딩에서 아무것도 고르지 않은 사람이 나중에 고르는 경로이기도 하다.
 *
 * **빈 배열도 유효한 선택이다**("지금은 필요한 것이 없다"). 그래서 이 함수를 부르는 것 자체가
 * 온보딩을 마쳤다는 뜻이고, `onboarded_at` 이 비어 있으면 이때 찍는다 — 앱이 온보딩을 다시
 * 띄우지 않게 하려면 "고른 것이 없다"와 "고른 적이 없다"가 구분되어야 한다(030).
 */
/**
 * 프로필 편집 — 닉네임·아바타·무장애 항목을 **온 것만** 갱신한다.
 *
 * ⚠️ 세 값의 "없음" 이 서로 다르다.
 *   · nickname   — undefined 면 그대로. 빈 문자열은 라우트가 이미 400 으로 막는다.
 *   · avatarUrl  — undefined 면 그대로, **null 이면 지우기**(기본 아바타로 되돌림).
 *   · features   — undefined 면 그대로, 빈 배열은 "필요한 것 없음" 이라는 유효한 값이다.
 *  그래서 coalesce 한 방으로 합칠 수 없고 세 컬럼을 각각 다룬다.
 *
 * onboarded_at 은 features 가 실제로 온 경우에만 찍는다 — 프로필에서 닉네임만 바꾼 것을
 * "온보딩을 마쳤다" 로 해석하면 앱이 온보딩을 다시 띄울 기회를 잃는다(030 주석과 같은 이유).
 */
export async function updateProfile(authorId: number, patch: {
  nickname?: string;
  avatarUrl?: string | null;
  features?: string[];
}): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [authorId];
  const add = (sql: string, v: unknown) => { vals.push(v); sets.push(sql.replace('?', `$${vals.length}`)); };

  if (patch.nickname !== undefined) add('nickname = ?', patch.nickname);
  // null 도 유효한 값(지우기)이라 undefined 만 걸러낸다.
  if (patch.avatarUrl !== undefined) add('avatar_url = ?', patch.avatarUrl);
  if (patch.features !== undefined) {
    add('access_features = ?', patch.features);
    sets.push('onboarded_at = coalesce(onboarded_at, now())');
  }
  if (sets.length === 0) return;

  await query(`update authors set ${sets.join(', ')} where id = $1`, vals);
}

export async function setAccessFeatures(authorId: number, features: string[]): Promise<void> {
  await query(
    `update authors
        set access_features = $2,
            onboarded_at    = coalesce(onboarded_at, now())
      where id = $1`,
    [authorId, features],
  );
}

/**
 * 이메일 소유 확인을 기록한다.
 * 확인한 주소를 함께 받아 **그 주소가 지금도 계정 주소일 때만** 찍는다 —
 * 코드를 받은 뒤 주소를 바꿨다면 그 확인은 새 주소에 대한 것이 아니다.
 */
export async function markEmailVerified(authorId: number, email: string): Promise<boolean> {
  const res = await query(
    `update authors set email_verified_at = now()
      where id = $1 and lower(email) = $2 and email_verified_at is null`,
    [authorId, normalizeEmail(email)],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * 로그아웃 — 기기 바인딩만 끊는다. 계정과 그 데이터는 그대로 남고, 다시 로그인하면 돌아온다.
 * authors.device_id 까지 비우는 것이 중요하다. 남겨 두면 구버전 폴백 경로가 방금 끊은
 * 바인딩을 되살려, 로그아웃한 기기에 계정 데이터가 다시 보인다.
 *
 * ⚠️ authorId 를 **반드시** 받는다. 이것 없이 deviceId 만으로 지우면, 유효한 세션 하나를 가진
 *    사람이 남의 deviceId 를 넘겨 그 기기의 바인딩을 삭제할 수 있다. 피해자가 익명이었다면
 *    기기와 계정을 잇는 유일한 연결이 사라져 그동안 쓴 것 전부에 도달할 수 없게 된다.
 */
export async function signOutDevice(deviceId: string, authorId: number): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      'delete from author_devices where device_id = $1 and author_id = $2',
      [deviceId, authorId],
    );
    await client.query(
      'update authors set device_id = null where device_id = $1 and id = $2',
      [deviceId, authorId],
    );
  });
}

// ── 내부 ─────────────────────────────────────────────────────────────────────
/**
 * 기기 바인딩 upsert.
 *
 * ⚠️ `rebind` 가 이 함수의 보안 경계다.
 *  세션이 생긴 뒤로는 "요청이 지목한 기기"와 "요청의 주인"이 서로 다른 출처에서 온다.
 *  그래서 조건 없이 author_id 를 덮어쓰면, 유효한 세션 하나만 가진 사람이 아무 쓰기 요청에
 *  남의 deviceId 를 실어 **그 기기를 자기 계정으로 가져올 수 있다.**
 *  (그 뒤 피해자의 무토큰 요청은 공격자 계정으로 해석되고, 피해자가 새로 쓰는 글도 그쪽에 쌓인다)
 *
 *  그래서 기기의 소유자를 바꾸는 것은 **로그인 경로에서만**(rebind=true) 허용한다.
 *  일반 쓰기 경로(rebind=false)는 이미 자기 기기일 때 last_seen_at 만 갱신하고,
 *  남의 기기면 아무 일도 하지 않는다(조용히 무시 — 에러를 내면 그것 자체가 "이 기기는 남의
 *  것"이라는 정보를 주고, 정상 사용자에게는 아무 의미 없는 실패가 된다).
 */
async function touchDevice(
  client: pg.PoolClient,
  deviceId: string,
  authorId: number,
  rebind = false,
): Promise<void> {
  await client.query(
    `insert into author_devices (device_id, author_id) values ($1, $2)
       on conflict (device_id) do update
          set author_id = excluded.author_id, last_seen_at = now()
        where $3::boolean or author_devices.author_id = excluded.author_id`,
    [deviceId, authorId, rebind],
  );
}
