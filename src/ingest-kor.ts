// 국문 관광정보(KorService2) / 무장애 여행(KorWithService2) 전국 POI 수집
// 사용: tsx src/ingest-kor.ts [kor|korwith]
import { config } from './config';
import { DailyLimitError, fetchApi, isSuccess, type ApiItem } from './client';
import { pool, withTransaction } from './db';
import { ENDPOINT, dbl, str, upsertChunked } from './util';

const COLUMNS = [
  'service', 'content_id', 'content_type_id', 'title', 'addr1', 'addr2', 'zipcode',
  'area_code', 'sigungu_code', 'ldong_regn_cd', 'ldong_signgu_cd',
  'cat1', 'cat2', 'cat3', 'lcls_systm1', 'lcls_systm2', 'lcls_systm3',
  'mapx', 'mapy', 'mlevel', 'tel', 'firstimage', 'firstimage2',
  'created_time', 'modified_time', 'raw', 'natural_key',
];

function toRow(service: string, it: ApiItem): unknown[] {
  return [
    service, str(it['contentid']), str(it['contenttypeid']), str(it['title']),
    str(it['addr1']), str(it['addr2']), str(it['zipcode']),
    str(it['areacode']), str(it['sigungucode']), str(it['lDongRegnCd']), str(it['lDongSignguCd']),
    str(it['cat1']), str(it['cat2']), str(it['cat3']),
    str(it['lclsSystm1']), str(it['lclsSystm2']), str(it['lclsSystm3']),
    dbl(it['mapx']), dbl(it['mapy']), str(it['mlevel']), str(it['tel']),
    str(it['firstimage']), str(it['firstimage2']), str(it['createdtime']), str(it['modifiedtime']),
    JSON.stringify(it), `${service}:${str(it['contentid'])}`,
  ];
}

const NUM = 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const service = (process.argv[2] === 'korwith' ? 'korwith' : 'kor') as 'kor' | 'korwith';
  const opUrl = `${service === 'kor' ? ENDPOINT.korService2 : ENDPOINT.korWithService2}/areaBasedList2`;

  let pageNo = 1;
  let totalPages = Infinity;
  let upserted = 0;
  let requests = 0;

  console.log(`[kor] service=${service} 수집 시작 (${opUrl})`);
  try {
    while (pageNo <= totalPages) {
      if (config.dailyRequestCap > 0 && requests >= config.dailyRequestCap) {
        console.log(`[kor] 일일 캡(${config.dailyRequestCap}) 도달 → 중단`);
        break;
      }
      const res = await fetchApi(opUrl, { numOfRows: NUM, pageNo });
      requests += 1;
      if (!isSuccess(res.resultCode)) throw new Error(`API 결과코드 ${res.resultCode}: ${res.resultMsg}`);

      if (totalPages === Infinity) {
        totalPages = res.totalCount > 0 ? Math.ceil(res.totalCount / NUM) : pageNo;
        console.log(`[kor] totalCount=${res.totalCount} → ${totalPages}페이지`);
      }
      if (res.items.length > 0) {
        const rows = res.items.map((it) => toRow(service, it));
        await withTransaction((c) => upsertChunked(c, 'kor_poi', COLUMNS, rows));
        upserted += rows.length;
      }
      console.log(`[kor] page ${pageNo}/${totalPages} · ${res.items.length}건 · 누적 ${upserted}`);
      if (res.items.length === 0) break;
      pageNo += 1;
      await sleep(config.requestDelayMs);
    }
    console.log(`[kor] ✅ ${service} 완료 · upsert ${upserted} · 요청 ${requests}`);
  } catch (err) {
    if (err instanceof DailyLimitError) console.warn(`[kor] ⛔ ${err.message}`);
    else { console.error('[kor] 실패:', (err as Error).message); process.exitCode = 1; }
  } finally {
    await pool.end();
  }
}

main();
