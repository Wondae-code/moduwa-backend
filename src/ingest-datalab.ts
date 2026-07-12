// 빅데이터_지역별 일별 방문자수 — 광역(metco)/기초(locgo), 월 단위 날짜범위로 수집
// DataLabService/{metco,locgo}RegnVisitrDDList (startYmd, endYmd 필수)
import { config, monthRange } from './config';
import { DailyLimitError, fetchApi, isSuccess, type ApiItem } from './client';
import { pool, withTransaction } from './db';
import { ENDPOINT, dbl, str, upsertChunked } from './util';

const COLUMNS = [
  'level', 'area_code', 'signgu_code', 'region_nm', 'base_ymd',
  'daywk_div_cd', 'daywk_div_nm', 'tou_div_cd', 'tou_div_nm', 'tou_num', 'raw', 'natural_key',
];
const LEVELS = [
  { level: 'metco', op: 'metcoRegnVisitrDDList', regionKey: 'areaCode', regionNm: 'areaNm' },
  { level: 'locgo', op: 'locgoRegnVisitrDDList', regionKey: 'signguCode', regionNm: 'signguNm' },
] as const;
const NUM = 5000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toRow(lv: (typeof LEVELS)[number], it: ApiItem): unknown[] {
  const region = str(it[lv.regionKey]);
  return [
    lv.level,
    lv.level === 'metco' ? region : null,
    lv.level === 'locgo' ? region : null,
    str(it[lv.regionNm]),
    str(it['baseYmd']), str(it['daywkDivCd']), str(it['daywkDivNm']),
    str(it['touDivCd']), str(it['touDivNm']), dbl(it['touNum']),
    JSON.stringify(it), `${lv.level}:${region}:${str(it['baseYmd'])}:${str(it['touDivCd'])}`,
  ];
}

function lastDay(ym: string): string {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(4, 6));
  return String(new Date(y, m, 0).getDate()).padStart(2, '0');
}

async function main() {
  const months = monthRange(config.baseYmStart, config.baseYmEnd);
  let upserted = 0, requests = 0;
  console.log(`[datalab] 수집 시작 · ${months.length}개월 × ${LEVELS.length}레벨`);
  try {
    for (const ym of months) {
      for (const lv of LEVELS) {
        if (config.dailyRequestCap > 0 && requests >= config.dailyRequestCap) {
          console.log(`[datalab] 일일 캡 도달 → 중단`); await pool.end(); return;
        }
        const startYmd = `${ym}01`, endYmd = `${ym}${lastDay(ym)}`;
        let pageNo = 1, total = Infinity, got = 0;
        while (pageNo <= total) {
          const res = await fetchApi(`${ENDPOINT.dataLab}/${lv.op}`, { numOfRows: NUM, pageNo, startYmd, endYmd });
          requests += 1;
          if (!isSuccess(res.resultCode)) throw new Error(`결과코드 ${res.resultCode}: ${res.resultMsg}`);
          if (total === Infinity) total = res.totalCount > 0 ? Math.ceil(res.totalCount / NUM) : pageNo;
          if (res.items.length > 0) {
            await withTransaction((c) => upsertChunked(c, 'datalab_visitor', COLUMNS, res.items.map((it) => toRow(lv, it))));
            got += res.items.length;
          }
          if (res.items.length === 0) break;
          pageNo += 1;
        }
        upserted += got;
        console.log(`[datalab] ${ym} ${lv.level} · ${got}건 · 누적 ${upserted}`);
        await sleep(config.requestDelayMs);
      }
    }
    console.log(`[datalab] ✅ 완료 · upsert ${upserted} · 요청 ${requests}`);
  } catch (err) {
    if (err instanceof DailyLimitError) console.warn(`[datalab] ⛔ ${err.message}`);
    else { console.error('[datalab] 실패:', (err as Error).message); process.exitCode = 1; }
  } finally {
    await pool.end();
  }
}

main();
