// KorService2 본 POI 상세 enrich — detailCommon2(개요·홈페이지·전화) + detailIntro2(운영시간·요금 등).
// 콘텐츠당 2호출(각 오퍼레이션 독립 1,000/일 쿼터). 관광지 유형 우선, 누락분만 이어서.
import { config } from './config';
import { DailyLimitError, fetchApi, type ApiItem } from './client';
import { pool, query, withTransaction } from './db';
import { ENDPOINT, str, upsertChunked } from './util';

interface Pend { content_id: string; content_type_id: string | null }
const COMMON = `${ENDPOINT.korService2}/detailCommon2`;
const INTRO = `${ENDPOINT.korService2}/detailIntro2`;
const COLUMNS = ['content_id', 'content_type_id', 'overview', 'homepage', 'tel', 'common_raw', 'intro_raw', 'has_common', 'has_intro'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function row(cid: string, ctype: string | null, common: ApiItem | null, intro: ApiItem | null): unknown[] {
  return [
    cid, ctype, str(common?.['overview']), str(common?.['homepage']), str(common?.['tel']),
    common ? JSON.stringify(common) : null, intro ? JSON.stringify(intro) : null,
    common != null, intro != null,
  ];
}

async function flush(buf: unknown[][]): Promise<void> {
  if (buf.length === 0) return;
  await withTransaction((c) => upsertChunked(c, 'kor_detail', COLUMNS, buf, 'content_id'));
  buf.length = 0;
}

async function main() {
  const types = config.kordetailTypes;
  const total = (await query<{ n: number }>(
    `select count(*)::int n from kor_poi where service='kor' and content_id is not null and content_type_id = any($1::text[])`,
    [types],
  )).rows[0]!.n;
  const done = (await query<{ n: number }>(
    `select count(*)::int n from kor_detail d where content_type_id = any($1::text[])`, [types],
  )).rows[0]!.n;
  console.log(`[kordetail] 대상유형 [${types.join(',')}] · 전체 ${total} · 완료 ${done} · 남음 ${total - done}`);

  const cap = config.dailyRequestCap > 0 ? config.dailyRequestCap : total;
  // 무장애(korwith) 대상 콘텐츠 우선 — 앱 장소 상세에서 바로 쓰이는 것부터 채운다.
  // 그 안에서는 숙박·음식점(아직 미수집) → 가볼 곳 순.
  const pend = await query<Pend>(
    `select k.content_id, k.content_type_id from kor_poi k
      where k.service='kor' and k.content_id is not null and k.content_type_id = any($1::text[])
        and not exists (select 1 from kor_detail d where d.content_id = k.content_id)
      order by (case when exists (select 1 from kor_poi w where w.service='korwith' and w.content_id = k.content_id)
                  then 0 else 1 end),
               (case k.content_type_id when '32' then 0 when '39' then 1 when '12' then 2 when '14' then 3
                  when '28' then 4 when '15' then 5 when '25' then 6 else 9 end), k.content_id
      limit ${cap}`,
    [types],
  );
  console.log(`[kordetail] 이번 실행 ${pend.rows.length}건 (콘텐츠당 2호출, cap=${config.dailyRequestCap || '∞'})`);

  const buf: unknown[][] = [];
  let processed = 0, withCommon = 0, withIntro = 0, stop = 'completed';
  try {
    for (const p of pend.rows) {
      let common: ApiItem | null = null;
      try {
        const r = await fetchApi(COMMON, { contentId: p.content_id });
        common = r.items[0] ?? null;
      } catch (e) {
        if (e instanceof DailyLimitError) throw e;
        console.warn(`  ⚠️ common ${p.content_id}: ${(e as Error).message} — 건너뜀`);
        continue; // common 실패 시 이 콘텐츠는 pending 유지
      }
      let intro: ApiItem | null = null;
      try {
        const r = await fetchApi(INTRO, { contentId: p.content_id, contentTypeId: p.content_type_id ?? '' });
        intro = r.items[0] ?? null;
      } catch (e) {
        if (e instanceof DailyLimitError) throw e;
        // intro 실패는 무시(common만 저장)
      }
      buf.push(row(p.content_id, p.content_type_id, common, intro));
      processed += 1;
      if (common) withCommon += 1;
      if (intro) withIntro += 1;
      if (buf.length >= 50) { await flush(buf); console.log(`[kordetail] ${processed}/${pend.rows.length} · 개요 ${withCommon} · 소개 ${withIntro}`); }
      await sleep(config.requestDelayMs);
    }
  } catch (e) {
    if (e instanceof DailyLimitError) { stop = 'api-limit'; console.warn(`[kordetail] ⛔ ${e.message}`); }
    else { stop = 'error'; console.error('[kordetail] 실패:', (e as Error).message); process.exitCode = 1; }
  } finally {
    await flush(buf);
  }

  const left = (await query<{ n: number }>(
    `select count(*)::int n from kor_poi k where k.service='kor' and k.content_id is not null
       and k.content_type_id = any($1::text[])
       and not exists (select 1 from kor_detail d where d.content_id=k.content_id)`,
    [types],
  )).rows[0]!.n;
  console.log(`[kordetail] 종료(${stop}) · 처리 ${processed} · 개요 ${withCommon} · 소개 ${withIntro} · 남음 ${left}`);
  await pool.end();
}

main().catch(async (e) => { console.error('[kordetail] 치명:', e); await pool.end(); process.exitCode = 1; });
