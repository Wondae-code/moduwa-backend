// 이메일 인증·비밀번호 재설정 코드 — 발급과 검증. 031_email_codes.sql 과 짝이다.
//
// 6자리 숫자를 쓴다(링크가 아니라). moduwa.app 에 웹 페이지가 없어 링크는 눌러도 도착할 곳이
// 없고, 코드는 앱 입력 화면 하나로 완결된다. 무장애 앱이라 스크린리더·숫자 키패드·iOS
// 자동완성이 모두 유리한 숫자를 고른 것이기도 하다.
//
// ⚠️ 6자리는 10^6 이라 **찍어서 맞출 수 있다.** 그것을 막는 것은 자릿수가 아니라
//    **코드별 시도 상한**이다(MAX_ATTEMPTS). 이 상한이 이 파일의 보안 경계다.
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { config } from '../config';
import { query, withTransaction } from '../db';

export type CodePurpose = 'verify' | 'reset';

/** 코드 하나에 허용하는 시도 횟수. 넘으면 그 코드를 폐기하고 재발송을 유도한다. */
const MAX_ATTEMPTS = 5;

/**
 * 저장용 해시. author_id 를 섞는 것이 중요하다 —
 * 순수 sha256(code) 는 후보가 100만 개뿐이라 무지개표 하나로 전부 역산된다.
 */
function hashCode(authorId: number, purpose: CodePurpose, code: string): string {
  return createHash('sha256').update(`${authorId}:${purpose}:${code}`).digest('hex');
}

/**
 * 코드를 발급한다. 같은 목적의 기존 미사용 코드는 함께 폐기한다.
 *
 * 폐기하지 않으면 재발송을 반복해 유효한 코드를 여러 개 쌓을 수 있고, 그러면 시도 상한이
 * 코드 개수만큼 늘어나 상한 자체가 무의미해진다.
 */
export async function issueCode(
  authorId: number,
  purpose: CodePurpose,
  email: string,
): Promise<{ code: string; minutes: number }> {
  const minutes = config.mail.codeMinutes;
  // randomInt 는 CSPRNG 다. Math.random 을 쓰면 코드가 예측 가능해진다.
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');

  await withTransaction(async (client) => {
    await client.query(
      `update author_email_codes set used_at = now()
        where author_id = $1 and purpose = $2 and used_at is null`,
      [authorId, purpose],
    );
    await client.query(
      `insert into author_email_codes (author_id, purpose, email, code_hash, expires_at)
       values ($1, $2, $3, $4, now() + make_interval(mins => $5))`,
      [authorId, purpose, email, hashCode(authorId, purpose, code), minutes],
    );
  });
  return { code, minutes };
}

export type ConsumeResult = 'ok' | 'invalid' | 'expired' | 'too_many';

/**
 * 코드를 검증하고 소비한다(단회용).
 *
 * `email` 을 함께 확인하는 이유: 코드를 받은 주소와 지금 계정 주소가 다를 수 있다.
 * "예전 주소로 보낸 코드"가 "지금 주소"를 인증해 버리면 안 된다.
 *
 * 행을 잠그고(for update) 처리한다 — 잠그지 않으면 같은 코드로 동시에 여러 번 시도해
 * attempts 증가를 앞지를 수 있고, 그러면 시도 상한을 우회할 수 있다.
 */
export async function consumeCode(
  authorId: number,
  purpose: CodePurpose,
  code: string,
  email: string,
): Promise<ConsumeResult> {
  if (!/^\d{6}$/.test(code)) return 'invalid';

  return withTransaction(async (client) => {
    const row = (await client.query<{
      id: string; code_hash: string; attempts: number; email: string; expired: boolean;
    }>(
      `select id, code_hash, attempts, email, (expires_at <= now()) as expired
         from author_email_codes
        where author_id = $1 and purpose = $2 and used_at is null
        order by created_at desc
        limit 1
          for update`,
      [authorId, purpose],
    )).rows[0];

    if (!row) return 'invalid';
    if (row.expired) return 'expired';
    if (row.attempts >= MAX_ATTEMPTS) {
      // 상한에 닿은 코드는 더 살려 둘 이유가 없다. 폐기하고 재발송을 유도한다.
      await client.query('update author_email_codes set used_at = now() where id = $1', [row.id]);
      return 'too_many';
    }

    // 성공이든 실패든 시도를 먼저 센다. 뒤에 세면 실패 경로에서 빠져나가며 세지 않게 된다.
    await client.query('update author_email_codes set attempts = attempts + 1 where id = $1', [row.id]);

    const expected = Buffer.from(row.code_hash, 'hex');
    const actual = Buffer.from(hashCode(authorId, purpose, code), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return 'invalid';
    if (row.email !== email) return 'invalid';

    await client.query('update author_email_codes set used_at = now() where id = $1', [row.id]);
    return 'ok';
  });
}

/** 마지막 발송 이후 지난 초. 재발송 간격 제한(스팸·메일 폭탄 방지)에 쓴다. 없으면 null. */
export async function secondsSinceLastCode(
  authorId: number,
  purpose: CodePurpose,
): Promise<number | null> {
  const row = (await query<{ secs: number }>(
    `select extract(epoch from (now() - created_at))::int as secs
       from author_email_codes
      where author_id = $1 and purpose = $2
      order by created_at desc limit 1`,
    [authorId, purpose],
  )).rows[0];
  return row?.secs ?? null;
}
