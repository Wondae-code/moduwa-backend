// 반려동물 동반여행(KorPetTourService2) 목록 수집 — areaBasedList2 전국 페이지네이션.
// 반려동물 동반 가능 관광지의 기본정보(이름·주소·좌표·사진·법정동·분류)를 pet_tour_poi에 적재.
import { config } from './config';
import { DailyLimitError, fetchApi, isSuccess, type ApiItem } from './client';
import { pool, withTransaction } from './db';
import { ENDPOINT, dbl, str, upsertChunked } from './util';

const COLUMNS = [
  'contentid', 'contenttypeid', 'title', 'addr1', 'addr2', 'tel',
  'mapx', 'mapy', 'firstimage', 'firstimage2', 'cpyrht_div_cd',
  'area_code', 'sigungu_code', 'ldong_regn_cd', 'ldong_signgu_cd',
  'cat1', 'cat2', 'cat3', 'lcls_systm1', 'lcls_systm2', 'lcls_systm3',
  'created_time', 'modified_time', 'raw',
];

function toRow(it: ApiItem): unknown[] {
  return [
    str(it['contentid']), str(it['contenttypeid']), str(it['title']),
    str(it['addr1']), str(it['addr2']), str(it['tel']),
    dbl(it['mapx']), dbl(it['mapy']), str(it['firstimage']), str(it['firstimage2']), str(it['cpyrhtDivCd']),
    str(it['areacode']), str(it['sigungucode']), str(it['lDongRegnCd']), str(it['lDongSignguCd']),
    str(it['cat1']), str(it['cat2']), str(it['cat3']),
    str(it['lclsSystm1']), str(it['lclsSystm2']), str(it['lclsSystm3']),
    str(it['createdtime']), str(it['modifiedtime']), JSON.stringify(it),
  ];
}

const NUM = 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const opUrl = `${ENDPOINT.korPetTour}/areaBasedList2`;
  let pageNo = 1;
  let totalPages = Infinity;
  let upserted = 0;
  let requests = 0;

  console.log(`[pet] 반려동물 동반여행 목록 수집 시작 (${opUrl})`);
  try {
    while (pageNo <= totalPages) {
      if (config.dailyRequestCap > 0 && requests >= config.dailyRequestCap) {
        console.log(`[pet] 일일 캡(${config.dailyRequestCap}) 도달 → 중단`);
        break;
      }
      const res = await fetchApi(opUrl, { numOfRows: NUM, pageNo });
      requests += 1;
      if (!isSuccess(res.resultCode)) throw new Error(`API 결과코드 ${res.resultCode}: ${res.resultMsg}`);

      if (totalPages === Infinity) {
        totalPages = res.totalCount > 0 ? Math.ceil(res.totalCount / NUM) : pageNo;
        console.log(`[pet] totalCount=${res.totalCount} → ${totalPages}페이지`);
      }
      if (res.items.length > 0) {
        const rows = res.items.map(toRow);
        await withTransaction((c) => upsertChunked(c, 'pet_tour_poi', COLUMNS, rows, 'contentid'));
        upserted += rows.length;
      }
      console.log(`[pet] page ${pageNo}/${totalPages} · ${res.items.length}건 · 누적 ${upserted}`);
      if (res.items.length === 0) break;
      pageNo += 1;
      await sleep(config.requestDelayMs);
    }
    console.log(`[pet] ✅ 목록 완료 · upsert ${upserted} · 요청 ${requests}`);
  } catch (err) {
    if (err instanceof DailyLimitError) console.warn(`[pet] ⛔ ${err.message}`);
    else { console.error('[pet] 실패:', (err as Error).message); process.exitCode = 1; }
  } finally {
    await pool.end();
  }
}

main();
