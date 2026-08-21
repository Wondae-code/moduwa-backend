import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db';

const here = dirname(fileURLToPath(import.meta.url));
const sqlDir = join(here, '..', 'sql');

// 어드바이저리 락 키. 값 자체는 뜻이 없고 다른 잠금과 겹치지 않기만 하면 된다('modu').
const LOCK_KEY = 0x6d6f6475;

/**
 * 마이그레이션 실행기.
 *
 * ── 왜 이력 테이블과 락이 필요한가 ─────────────────────────────────────────────
 * 예전에는 sql/*.sql 전체를 매번 재실행했다(파일이 전부 멱등이라 그래도 됐다).
 * 그런데 배포 중 컨테이너를 띄울 때 이걸 돌리면 **구·신 컨테이너가 겹치는 순간** 둘이 같은
 * `alter table` 을 실행하며 ACCESS EXCLUSIVE 락을 서로 기다린다. 실제로 013(컬럼 추가 한 줄)에서
 * 무한 대기에 빠져 서비스가 502 로 내려갔다.
 *
 *   · 이력 테이블 — 이미 적용된 파일을 건너뛴다. 평소 실행이 거의 즉시 끝나 겹칠 틈이 줄고,
 *                   그만큼 락을 잡을 일 자체가 없어진다.
 *   · 어드바이저리 락 — 그래도 겹치면 **한 프로세스만** 진행하고 나머지는 기다린다.
 *                       기다린 쪽은 깨어나서 "할 게 없음"을 확인하고 지나간다.
 *   · lock_timeout — 그래도 막히면 무한 대기 대신 명확한 에러로 끝낸다. 원인 모를 502 보다
 *                    크래시가 낫다(로그에 무엇이 막혔는지 남는다).
 *
 * 파일 **내용 해시**로 판단하므로, 파일을 고치면 다시 적용된다 — 기존 작업 방식이 그대로 유지된다.
 *
 * ⚠️ 동작 하나가 바뀐다: 028·031 끝의 `delete from ...`(만료 세션·코드 청소)는 이제 그 파일이
 *    바뀔 때만 돈다. 청소는 없어도 안전하다(만료된 것은 조회 조건에서 이미 걸러진다).
 *    주기적 청소가 필요해지면 별도 잡으로 두는 것이 맞다.
 */
async function main() {
  const files = (await readdir(sqlDir)).filter((f) => f.endsWith('.sql')).sort();
  if (files.length === 0) {
    console.warn(`[migrate] ${sqlDir} 에 .sql 파일이 없습니다.`);
    return;
  }

  // 세션 단위 락이라 전용 커넥션이 필요하다(풀에서 매번 다른 커넥션을 받으면 락이 풀린다).
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query(`
      create table if not exists schema_migrations (
        filename   text primary key,
        sha256     text not null,
        applied_at timestamptz not null default now()
      )`);

    await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    locked = true;
    // 막힌 채로 매달려 있지 않게 한다. 배포 중 이전 컨테이너의 조회가 끝나기를 기다리는
    // 정상적인 대기는 이보다 훨씬 짧다.
    await client.query("set lock_timeout = '15s'");

    const applied = new Map<string, string>(
      (await client.query<{ filename: string; sha256: string }>(
        'select filename, sha256 from schema_migrations',
      )).rows.map((r) => [r.filename, r.sha256]),
    );

    let ran = 0;
    for (const file of files) {
      const sql = await readFile(join(sqlDir, file), 'utf8');
      const hash = createHash('sha256').update(sql).digest('hex');
      if (applied.get(file) === hash) continue;

      process.stdout.write(`[migrate] ${file} 적용 중... `);
      await client.query(sql);
      await client.query(
        `insert into schema_migrations (filename, sha256) values ($1, $2)
           on conflict (filename) do update set sha256 = excluded.sha256, applied_at = now()`,
        [file, hash],
      );
      console.log('done');
      ran += 1;
    }
    console.log(ran === 0
      ? `[migrate] 변경 없음 — ${files.length}개 파일 모두 최신`
      : `[migrate] ${ran}개 적용 완료 (전체 ${files.length}개)`);
  } finally {
    if (locked) await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

main()
  .catch((err) => {
    console.error('[migrate] 실패:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
