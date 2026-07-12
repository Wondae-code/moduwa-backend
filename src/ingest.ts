import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, monthRange } from './config';
import { DailyLimitError, fetchAreaBasedList } from './client';
import { upsertRecords } from './tourapi';
import { pool, query, withTransaction } from './db';

interface Sigungu {
  areaCd: string;
  areaNm: string;
  signguCd: string;
  signguNm: string;
}
interface Task {
  id: number;
  base_ym: string;
  area_cd: string;
  signgu_cd: string;
  signgu_nm: string | null;
}

class CapReached extends Error {}

const here = dirname(fileURLToPath(import.meta.url));
const sigungus = JSON.parse(
  readFileSync(join(here, 'sigungu-codes.json'), 'utf8'),
) as Sigungu[];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SUCCESS = new Set(['0000', '00', '0']);

/** (월 × 시군구) 작업을 멱등 시딩. 이미 있으면 건너뜀. */
async function seedTasks(): Promise<void> {
  const months = monthRange(config.baseYmStart, config.baseYmEnd);
  const rows: Array<[string, string, string, string]> = [];
  for (const ym of months)
    for (const s of sigungus) rows.push([ym, s.areaCd, s.signguCd, s.signguNm]);

  const CHUNK = 1000;
  let seeded = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values: string[] = [];
    const params: unknown[] = [];
    chunk.forEach((r, idx) => {
      const b = idx * 4;
      values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4})`);
      params.push(...r);
    });
    const res = await query(
      `insert into tar_rlte_tasks (base_ym, area_cd, signgu_cd, signgu_nm)
       values ${values.join(',')}
       on conflict (base_ym, signgu_cd) do nothing`,
      params,
    );
    seeded += res.rowCount ?? 0;
  }
  console.log(
    `[seed] ${months.length}개월 × ${sigungus.length}시군구 = ${rows.length} 작업 / 신규 ${seeded}`,
  );
}

/** 한 작업(월×시군구)을 페이지네이션하며 적재. requests 증가/캡 체크 콜백 사용. */
async function processTask(
  t: Task,
  state: { requests: number },
): Promise<{ fetched: number; pages: number; total: number; code: string }> {
  let pageNo = 1;
  let fetched = 0;
  let pages = 0;
  let total = 0;
  let code = '';

  for (;;) {
    if (config.dailyRequestCap > 0 && state.requests >= config.dailyRequestCap) {
      throw new CapReached();
    }
    const res = await fetchAreaBasedList({
      baseYm: t.base_ym,
      areaCd: t.area_cd,
      signguCd: t.signgu_cd,
      pageNo,
    });
    state.requests += 1;
    pages += 1;
    total = res.totalCount;
    code = res.resultCode;

    if (res.resultCode && !SUCCESS.has(res.resultCode)) {
      throw new Error(`API 결과코드 ${res.resultCode}: ${res.resultMsg}`);
    }
    if (res.items.length > 0) {
      await withTransaction((client) => upsertRecords(client, res.items));
      fetched += res.items.length;
    }

    if (res.items.length === 0 || pageNo * res.numOfRows >= total) break;
    pageNo += 1;
    await sleep(config.requestDelayMs);
  }
  return { fetched, pages, total, code };
}

async function main() {
  const seedOnly = process.argv.includes('--seed-only');
  await seedTasks();
  if (seedOnly) {
    await pool.end();
    return;
  }

  const counts = await query<{ status: string; n: number }>(
    `select status, count(*)::int as n from tar_rlte_tasks group by status`,
  );
  const summary = Object.fromEntries(counts.rows.map((r) => [r.status, r.n]));
  console.log('[ingest] 작업 현황:', summary);

  const run = await query<{ id: number }>(
    `insert into ingest_runs (base_ym_start, base_ym_end) values ($1,$2) returning id`,
    [config.baseYmStart, config.baseYmEnd],
  );
  const runId = run.rows[0]!.id;

  // 이번 실행에서 처리할 후보(최신월 우선). 캡이 있으면 그만큼만.
  const limit = config.dailyRequestCap > 0 ? config.dailyRequestCap : null;
  const tasks = await query<Task>(
    `select id, base_ym, area_cd, signgu_cd, signgu_nm
       from tar_rlte_tasks
      where status in ('pending','error') and attempts < 5
      order by base_ym desc, signgu_cd
      ${limit ? `limit ${limit}` : ''}`,
  );
  console.log(`[ingest] 이번 실행 후보 작업: ${tasks.rows.length}건 (cap=${config.dailyRequestCap || '∞'})`);

  const state = { requests: 0 };
  let tasksDone = 0;
  let recordsUpserted = 0;
  let stopReason = 'completed';

  for (const t of tasks.rows) {
    if (config.dailyRequestCap > 0 && state.requests >= config.dailyRequestCap) {
      stopReason = 'daily-cap';
      break;
    }
    await query(`update tar_rlte_tasks set started_at = now() where id = $1`, [t.id]);
    try {
      const r = await processTask(t, state);
      await query(
        `update tar_rlte_tasks
            set status=$2, total_count=$3, pages=$4, fetched=$5, result_code=$6,
                error=null, updated_at=now()
          where id=$1`,
        [t.id, r.fetched > 0 ? 'done' : 'nodata', r.total, r.pages, r.fetched, r.code],
      );
      tasksDone += 1;
      recordsUpserted += r.fetched;
      console.log(
        `  [${tasksDone}] ${t.base_ym} ${t.signgu_nm ?? t.signgu_cd} · ` +
          `${r.fetched}/${r.total}건 (p${r.pages}) · 누적요청 ${state.requests}`,
      );
    } catch (err) {
      if (err instanceof CapReached) {
        stopReason = 'daily-cap';
        break;
      }
      if (err instanceof DailyLimitError) {
        stopReason = 'api-limit';
        console.warn(`[ingest] ⛔ ${err.message} → 오늘 수집 중단(작업은 pending 유지)`);
        break;
      }
      await query(
        `update tar_rlte_tasks set status='error', attempts=attempts+1, error=$2, updated_at=now()
          where id=$1`,
        [t.id, (err as Error).message],
      );
      console.warn(`  ⚠️ ${t.base_ym} ${t.signgu_nm ?? t.signgu_cd} 실패: ${(err as Error).message}`);
    }
  }

  const remain = await query<{ n: number }>(
    `select count(*)::int as n from tar_rlte_tasks where status in ('pending','error')`,
  );
  const left = remain.rows[0]!.n;
  // 배치 한도(=cap)만큼만 뽑아 자연 종료한 경우도 일일캡 도달로 표시
  if (stopReason === 'completed' && left > 0) stopReason = 'daily-cap';

  await query(
    `update ingest_runs set requests_made=$2, tasks_done=$3, records_upserted=$4,
        stopped_reason=$5, finished_at=now() where id=$1`,
    [runId, state.requests, tasksDone, recordsUpserted, stopReason],
  );
  console.log(
    `\n[ingest] 종료(${stopReason}) · 작업 ${tasksDone}건 · 레코드 ${recordsUpserted} · 요청 ${state.requests}`,
  );
  if (left > 0) {
    console.log(`[ingest] 남은 작업 ${left}건 — 다시 'npm run ingest' 실행하면 이어서 재개합니다.`);
  } else {
    console.log('[ingest] ✅ 모든 작업 완료!');
  }
  await pool.end();
}

main().catch(async (err) => {
  console.error('[ingest] 치명적 오류:', err);
  await pool.end();
  process.exitCode = 1;
});
