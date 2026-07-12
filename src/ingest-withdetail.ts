// 무장애 상세(KorWithService2/detailWithTour2) enrich — content_id당 1요청.
// kor_with_detail에 없는 korwith content_id만 골라 채움(재실행 시 누락분만, 일일 캡까지).
import { config } from './config';
import { DailyLimitError, fetchApi, isSuccess, type ApiItem } from './client';
import { pool, query, withTransaction } from './db';
import { ENDPOINT, str, upsertChunked } from './util';

const ATTRS = [
  'parking', 'route', 'publictransport', 'ticketoffice', 'promotion', 'wheelchair', 'exit',
  'elevator', 'restroom', 'auditorium', 'room', 'handicapetc',
  'braileblock', 'helpdog', 'guidehuman', 'audioguide', 'bigprint', 'brailepromotion',
  'guidesystem', 'blindhandicapetc',
  'signguide', 'videoguide', 'hearingroom', 'hearinghandicapetc',
  'stroller', 'lactationroom', 'babysparechair', 'infantsfamilyetc',
];
const COLUMNS = ['content_id', ...ATTRS, 'has_detail', 'raw'];
const opUrl = `${ENDPOINT.korWithService2}/detailWithTour2`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toRow(contentId: string, item: ApiItem | null): unknown[] {
  const vals = ATTRS.map((a) => (item ? str(item[a]) : null));
  const has = vals.some((v) => v !== null);
  return [contentId, ...vals, has, item ? JSON.stringify(item) : null];
}

async function flush(buf: unknown[][]): Promise<void> {
  if (buf.length === 0) return;
  await withTransaction((c) => upsertChunked(c, 'kor_with_detail', COLUMNS, buf, 'content_id'));
  buf.length = 0;
}

async function main() {
  const total = (await query<{ n: number }>(
    `select count(*)::int n from kor_poi where service='korwith' and content_id is not null`,
  )).rows[0]!.n;
  const done = (await query<{ n: number }>(`select count(*)::int n from kor_with_detail`)).rows[0]!.n;
  console.log(`[withdetail] 전체 ${total} · 완료 ${done} · 남음 ${total - done}`);

  const limit = config.dailyRequestCap > 0 ? config.dailyRequestCap : total;
  const pend = await query<{ content_id: string }>(
    `select k.content_id from kor_poi k
      where k.service='korwith' and k.content_id is not null
        and not exists (select 1 from kor_with_detail d where d.content_id = k.content_id)
      order by k.content_id limit ${limit}`,
  );
  console.log(`[withdetail] 이번 실행 ${pend.rows.length}건 (cap=${config.dailyRequestCap || '∞'})`);

  const buf: unknown[][] = [];
  let requests = 0, withInfo = 0, stop = 'completed';
  try {
    for (const { content_id } of pend.rows) {
      const res = await fetchApi(opUrl, { contentId: content_id });
      requests += 1;
      if (!isSuccess(res.resultCode)) throw new Error(`결과코드 ${res.resultCode}: ${res.resultMsg}`);
      const item = res.items[0] ?? null;
      const row = toRow(content_id, item);
      if (row[row.length - 2] === true) withInfo += 1;
      buf.push(row);
      if (buf.length >= 100) { await flush(buf); console.log(`[withdetail] ${requests}/${pend.rows.length} · 속성보유 ${withInfo}`); }
      await sleep(config.requestDelayMs);
    }
  } catch (err) {
    if (err instanceof DailyLimitError) { stop = 'api-limit'; console.warn(`[withdetail] ⛔ ${err.message}`); }
    else { stop = 'error'; console.error('[withdetail] 실패:', (err as Error).message); process.exitCode = 1; }
  } finally {
    await flush(buf);
  }

  const left = (await query<{ n: number }>(
    `select count(*)::int n from kor_poi k where k.service='korwith' and k.content_id is not null
       and not exists (select 1 from kor_with_detail d where d.content_id=k.content_id)`,
  )).rows[0]!.n;
  console.log(`[withdetail] 종료(${stop}) · 이번 요청 ${requests} · 속성보유 ${withInfo} · 남음 ${left}`);
  await pool.end();
}

main().catch(async (e) => { console.error('[withdetail] 치명:', e); await pool.end(); process.exitCode = 1; });
