// 반려동물 전용 상세(detailPetTour2) enrich — 콘텐츠당 1호출(1,000/일 쿼터), 누락분만 이어서 수집.
// 동반유형·동반가능동물·동반시 필요사항·기타 동반정보 등 반려동물 특화 항목을 pet_tour_detail에 적재.
import { config } from './config';
import { DailyLimitError, fetchApi, type ApiItem } from './client';
import { pool, query, withTransaction } from './db';
import { ENDPOINT, str, upsertChunked } from './util';

const DETAIL = `${ENDPOINT.korPetTour}/detailPetTour2`;
const COLUMNS = [
  'contentid', 'acmpy_type_cd', 'acmpy_psbl_cpam', 'acmpy_need_mtr', 'etc_acmpy_info',
  'rela_acdnt_risk_mtr', 'rela_poses_fclty', 'rela_frnsh_prdlst', 'rela_purc_prdlst', 'rela_rntl_prdlst', 'raw',
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toRow(cid: string, it: ApiItem | null): unknown[] {
  return [
    cid, str(it?.['acmpyTypeCd']), str(it?.['acmpyPsblCpam']), str(it?.['acmpyNeedMtr']), str(it?.['etcAcmpyInfo']),
    str(it?.['relaAcdntRiskMtr']), str(it?.['relaPosesFclty']), str(it?.['relaFrnshPrdlst']),
    str(it?.['relaPurcPrdlst']), str(it?.['relaRntlPrdlst']), it ? JSON.stringify(it) : null,
  ];
}

async function flush(buf: unknown[][]): Promise<void> {
  if (buf.length === 0) return;
  await withTransaction((c) => upsertChunked(c, 'pet_tour_detail', COLUMNS, buf, 'contentid'));
  buf.length = 0;
}

async function main() {
  const total = (await query<{ n: number }>(`select count(*)::int n from pet_tour_poi`)).rows[0]!.n;
  const done = (await query<{ n: number }>(`select count(*)::int n from pet_tour_detail`)).rows[0]!.n;
  console.log(`[pet-detail] 전체 ${total} · 완료 ${done} · 남음 ${total - done}`);

  const cap = config.dailyRequestCap > 0 ? config.dailyRequestCap : total;
  const pend = (await query<{ contentid: string }>(
    `select p.contentid from pet_tour_poi p
      where not exists (select 1 from pet_tour_detail d where d.contentid = p.contentid)
      order by p.contentid limit ${cap}`,
  )).rows;
  console.log(`[pet-detail] 이번 실행 ${pend.length}건 (콘텐츠당 1호출, cap=${config.dailyRequestCap || '∞'})`);

  const buf: unknown[][] = [];
  let processed = 0, withData = 0, stop = 'completed';
  try {
    for (const p of pend) {
      let it: ApiItem | null = null;
      try {
        const r = await fetchApi(DETAIL, { contentId: p.contentid });
        it = r.items[0] ?? null;
      } catch (e) {
        if (e instanceof DailyLimitError) throw e;
        console.warn(`  ⚠️ ${p.contentid}: ${(e as Error).message} — 건너뜀`);
        continue; // 실패 시 pending 유지(다음 실행에서 재시도)
      }
      buf.push(toRow(p.contentid, it));
      processed += 1;
      if (it && (it['acmpyTypeCd'] || it['acmpyPsblCpam'] || it['etcAcmpyInfo'])) withData += 1;
      if (buf.length >= 50) { await flush(buf); console.log(`[pet-detail] ${processed}/${pend.length} · 정보보유 ${withData}`); }
      await sleep(config.requestDelayMs);
    }
  } catch (e) {
    if (e instanceof DailyLimitError) { stop = 'api-limit'; console.warn(`[pet-detail] ⛔ ${e.message}`); }
    else { stop = 'error'; console.error('[pet-detail] 실패:', (e as Error).message); process.exitCode = 1; }
  } finally {
    await flush(buf);
  }

  const left = (await query<{ n: number }>(
    `select count(*)::int n from pet_tour_poi p
      where not exists (select 1 from pet_tour_detail d where d.contentid = p.contentid)`,
  )).rows[0]!.n;
  console.log(`[pet-detail] 종료(${stop}) · 처리 ${processed} · 정보보유 ${withData} · 남음 ${left}`);
  await pool.end();
}

main().catch(async (e) => { console.error('[pet-detail] 치명:', e); await pool.end(); process.exitCode = 1; });
