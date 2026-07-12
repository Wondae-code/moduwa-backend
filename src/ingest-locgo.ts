// 기초지자체 중심 관광지(LocgoHubTarService1/areaBasedList1) — 시군구×월 작업큐 수집
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, monthRange } from './config';
import { DailyLimitError, fetchApi, isSuccess, type ApiItem } from './client';
import { pool, query, withTransaction } from './db';
import { ENDPOINT, dbl, intg, str, upsertChunked } from './util';

interface Sigungu { areaCd: string; signguCd: string; signguNm: string }
interface Task { id: number; base_ym: string; area_cd: string; signgu_cd: string; signgu_nm: string | null }
class CapReached extends Error {}

const here = dirname(fileURLToPath(import.meta.url));
const sigungus = JSON.parse(readFileSync(join(here, 'sigungu-codes.json'), 'utf8')) as Sigungu[];
const opUrl = `${ENDPOINT.locgoHub}/areaBasedList1`;
const NUM = 2000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const COLUMNS = [
  'base_ym', 'hub_tats_cd', 'hub_tats_nm', 'area_cd', 'area_nm', 'signgu_cd', 'signgu_nm',
  'map_x', 'map_y', 'hub_ctgry_lcls_nm', 'hub_ctgry_mcls_nm', 'hub_rank', 'raw', 'natural_key',
];
function toRow(it: ApiItem): unknown[] {
  return [
    str(it['baseYm']), str(it['hubTatsCd']), str(it['hubTatsNm']),
    str(it['areaCd']), str(it['areaNm']), str(it['signguCd']), str(it['signguNm']),
    dbl(it['mapX']), dbl(it['mapY']),
    str(it['hubCtgryLclsNm']), str(it['hubCtgryMclsNm']), intg(it['hubRank']),
    JSON.stringify(it), `${str(it['baseYm'])}:${str(it['signguCd'])}:${str(it['hubTatsCd'])}`,
  ];
}

async function seed(): Promise<void> {
  const months = monthRange(config.baseYmStart, config.baseYmEnd);
  const rows: Array<[string, string, string, string]> = [];
  for (const ym of months) for (const s of sigungus) rows.push([ym, s.areaCd, s.signguCd, s.signguNm]);
  const CHUNK = 1000;
  let seeded = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const vals: string[] = []; const params: unknown[] = [];
    chunk.forEach((r, idx) => { const b = idx * 4; vals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4})`); params.push(...r); });
    const res = await query(
      `insert into locgo_hub_tasks (base_ym, area_cd, signgu_cd, signgu_nm) values ${vals.join(',')}
       on conflict (base_ym, signgu_cd) do nothing`, params);
    seeded += res.rowCount ?? 0;
  }
  console.log(`[locgo] seed ${months.length}개월 × ${sigungus.length}시군구 / 신규 ${seeded}`);
}

async function processTask(t: Task, state: { requests: number }): Promise<{ fetched: number; total: number; code: string }> {
  let pageNo = 1, total = Infinity, fetched = 0, code = '';
  while (pageNo <= total) {
    if (config.dailyRequestCap > 0 && state.requests >= config.dailyRequestCap) throw new CapReached();
    const res = await fetchApi(opUrl, { numOfRows: NUM, pageNo, baseYm: t.base_ym, areaCd: t.area_cd, signguCd: t.signgu_cd });
    state.requests += 1; code = res.resultCode;
    if (!isSuccess(res.resultCode)) throw new Error(`결과코드 ${res.resultCode}: ${res.resultMsg}`);
    if (total === Infinity) total = res.totalCount > 0 ? Math.ceil(res.totalCount / res.numOfRows) : pageNo;
    if (res.items.length > 0) { await withTransaction((c) => upsertChunked(c, 'locgo_hub_records', COLUMNS, res.items.map(toRow))); fetched += res.items.length; }
    if (res.items.length === 0 || pageNo * res.numOfRows >= res.totalCount) break;
    pageNo += 1; await sleep(config.requestDelayMs);
  }
  return { fetched, total: total === Infinity ? 0 : total, code };
}

async function main() {
  await seed();
  const counts = await query<{ status: string; n: number }>(`select status, count(*)::int n from locgo_hub_tasks group by status`);
  console.log('[locgo] 작업현황:', Object.fromEntries(counts.rows.map((r) => [r.status, r.n])));

  const limit = config.dailyRequestCap > 0 ? config.dailyRequestCap : null;
  const tasks = await query<Task>(
    `select id, base_ym, area_cd, signgu_cd, signgu_nm from locgo_hub_tasks
      where status in ('pending','error') and attempts < 5
      order by base_ym desc, signgu_cd ${limit ? `limit ${limit}` : ''}`);
  console.log(`[locgo] 후보 ${tasks.rows.length}건 (cap=${config.dailyRequestCap || '∞'})`);

  const state = { requests: 0 };
  let done = 0, recs = 0, stop = 'completed';
  for (const t of tasks.rows) {
    if (config.dailyRequestCap > 0 && state.requests >= config.dailyRequestCap) { stop = 'daily-cap'; break; }
    await query(`update locgo_hub_tasks set started_at=now() where id=$1`, [t.id]);
    try {
      const r = await processTask(t, state);
      await query(`update locgo_hub_tasks set status=$2, total_count=$3, fetched=$4, result_code=$5, error=null, updated_at=now() where id=$1`,
        [t.id, r.fetched > 0 ? 'done' : 'nodata', r.total, r.fetched, r.code]);
      done += 1; recs += r.fetched;
      if (done % 50 === 0) console.log(`[locgo] ${done} · ${t.base_ym} ${t.signgu_nm} · 누적 ${recs} · 요청 ${state.requests}`);
    } catch (err) {
      if (err instanceof CapReached) { stop = 'daily-cap'; break; }
      if (err instanceof DailyLimitError) { stop = 'api-limit'; console.warn(`[locgo] ⛔ ${err.message}`); break; }
      await query(`update locgo_hub_tasks set status='error', attempts=attempts+1, error=$2, updated_at=now() where id=$1`, [t.id, (err as Error).message]);
    }
  }
  const left = (await query<{ n: number }>(`select count(*)::int n from locgo_hub_tasks where status in ('pending','error')`)).rows[0]!.n;
  console.log(`[locgo] 종료(${stop}) · 작업 ${done} · 레코드 ${recs} · 요청 ${state.requests} · 남음 ${left}`);
  await pool.end();
}

main().catch(async (e) => { console.error('[locgo] 치명:', e); await pool.end(); process.exitCode = 1; });
