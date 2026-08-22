import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { pool } from './db';

const here = dirname(fileURLToPath(import.meta.url));
const sqlDir = join(here, '..', 'sql');

// 어드바이저리 락 키. 값 자체는 뜻이 없고 다른 잠금과 겹치지 않기만 하면 된다('modu').
const LOCK_KEY = 0x6d6f6475;

/** 어드바이저리 락을 기다리는 시한. 넘으면 무엇이 쥐고 있는지 알려주고 끝낸다. */
const LOCK_WAIT_MS = 30_000;

/** 락을 쥔 세션을 찾아 조치할 수 있는 형태로 알려준다. 그냥 "실패"보다 훨씬 쓸모 있다. */
async function lockHolderMessage(client: pg.PoolClient): Promise<string> {
  const rows = (await client.query<{ pid: number; state: string; secs: number }>(
    `select a.pid, a.state, extract(epoch from (now() - a.state_change))::int as secs
       from pg_locks l join pg_stat_activity a on a.pid = l.pid
      where l.locktype = 'advisory' and l.objid = $1 and l.granted`,
    [LOCK_KEY],
  )).rows;
  if (rows.length === 0) {
    return '다른 프로세스가 마이그레이션 잠금을 쥐고 있습니다(소유자 확인 실패). 잠시 후 다시 시도하세요.';
  }
  const who = rows.map((r) => `pid ${r.pid} (${r.state}, ${r.secs}초째)`).join(', ');
  return `다른 프로세스가 마이그레이션 잠금을 쥐고 있습니다 — ${who}.\n`
    + `  중단된 실행이 남긴 유령 세션일 수 있습니다. 그렇다면 아래로 정리하세요:\n`
    + `    select pg_terminate_backend(${rows[0]!.pid});`;
}

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
  console.log('[migrate] DB 연결 중...');
  const client = await pool.connect();

  // 이 실행을 pg_stat_activity 에서 알아볼 수 있게 표식을 남긴다.
  await client.query("set application_name = 'moduwa-migrate'");

  // ⚠️ 유령 세션의 **근본 방지.** 클라이언트가 죽어도(Ctrl+C·네트워크 단절) 서버는 결과를
  //    쓰려는 순간까지 끊김을 모른 채 문장을 계속 실행하고, 세션 락(어드바이저리 락 포함)을
  //    계속 쥔다. 프록시(Railway) 뒤에서는 그 "순간"이 수십 분씩 늦어져 실제로 두 번 발생했다.
  //    이 설정(PG14+)은 긴 문장 실행 중에도 10초마다 소켓 생존을 확인해 죽은 세션을 끝낸다.
  const alive = await client.query("set client_connection_check_interval = '10s'")
    .then(() => true, () => false);
  if (!alive) console.warn('[migrate] client_connection_check_interval 미지원(PG13 이하) — 유령 세션 자동 정리 없이 진행');

  const backendPid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;

  // Ctrl+C 는 클라이언트만 죽인다 — **서버 쪽 실행을 함께 취소**해야 유령 세션이 안 남는다.
  // 실행 중인 커넥션으로는 명령을 보낼 수 없으므로 새 커넥션에서 우리 백엔드를 취소한다.
  // 취소되면 진행 중이던 await 가 에러로 풀리며 아래 finally 가 락 해제까지 정리한다.
  const onSignal = () => {
    console.error('\n[migrate] 중단 요청 — 서버 쪽 실행을 취소하는 중...');
    pool.connect().then(async (c2) => {
      try { await c2.query('select pg_cancel_backend($1)', [backendPid]); } finally { c2.release(); }
    }).catch(() => process.exit(130));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  let locked = false;
  try {
    await client.query(`
      create table if not exists schema_migrations (
        filename   text primary key,
        sha256     text not null,
        applied_at timestamptz not null default now()
      )`);

    // ⚠️ pg_advisory_lock 은 **무한정 기다린다.** lock_timeout 은 여기에 적용되지 않는다
    //    (그 설정은 테이블 락에만 걸린다). 그래서 try 판을 돌려 직접 시한을 만든다.
    //    실제로 프록시를 통한 실행이 중간에 끊기면 DB 쪽 세션이 락을 쥔 채 남을 수 있고,
    //    그때 이 함수가 아무 출력 없이 영원히 멈춰 있었다.
    console.log('[migrate] 잠금 획득 중...');
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      const got = (await client.query<{ ok: boolean }>(
        'select pg_try_advisory_lock($1) as ok', [LOCK_KEY],
      )).rows[0]!.ok;
      if (got) break;
      if (Date.now() >= deadline) throw new Error(await lockHolderMessage(client));
      await new Promise((r) => setTimeout(r, 1000));
    }
    locked = true;
    // 테이블 락(alter table 등)이 막힐 때 무한 대기하지 않게 한다.
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
