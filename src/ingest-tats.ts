// 관광지 집중률(향후 30일) 수집 — 시군구별(252) 순회
// TatsCnctrRateService/tatsCnctrRatedList (areaCd, signguCd 필수)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config';
import { DailyLimitError, fetchApi, isSuccess, type ApiItem } from './client';
import { pool, withTransaction } from './db';
import { ENDPOINT, dbl, str, upsertChunked } from './util';

interface Sigungu { areaCd: string; signguCd: string; signguNm: string }
const here = dirname(fileURLToPath(import.meta.url));
const sigungus = JSON.parse(readFileSync(join(here, 'sigungu-codes.json'), 'utf8')) as Sigungu[];

const COLUMNS = ['area_cd', 'area_nm', 'signgu_cd', 'signgu_nm', 't_ats_nm', 'base_ymd', 'cnctr_rate', 'raw', 'natural_key'];
const NUM = 3000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toRow(it: ApiItem): unknown[] {
  return [
    str(it['areaCd']), str(it['areaNm']), str(it['signguCd']), str(it['signguNm']),
    str(it['tAtsNm']), str(it['baseYmd']), dbl(it['cnctrRate']),
    JSON.stringify(it), `${str(it['signguCd'])}:${str(it['tAtsNm'])}:${str(it['baseYmd'])}`,
  ];
}

async function main() {
  const opUrl = `${ENDPOINT.tatsCnctr}/tatsCnctrRatedList`;
  let upserted = 0, requests = 0, done = 0;
  console.log(`[tats] 집중률 수집 시작 · ${sigungus.length}개 시군구`);
  try {
    for (const s of sigungus) {
      if (config.dailyRequestCap > 0 && requests >= config.dailyRequestCap) {
        console.log(`[tats] 일일 캡 도달 → 중단 (${done}/${sigungus.length})`); break;
      }
      let pageNo = 1, total = Infinity, got = 0;
      while (pageNo <= total) {
        const res = await fetchApi(opUrl, { numOfRows: NUM, pageNo, areaCd: s.areaCd, signguCd: s.signguCd });
        requests += 1;
        if (!isSuccess(res.resultCode)) throw new Error(`결과코드 ${res.resultCode}: ${res.resultMsg}`);
        if (total === Infinity) total = res.totalCount > 0 ? Math.ceil(res.totalCount / NUM) : pageNo;
        if (res.items.length > 0) {
          await withTransaction((c) => upsertChunked(c, 'tats_cnctr', COLUMNS, res.items.map(toRow)));
          got += res.items.length;
        }
        if (res.items.length === 0) break;
        pageNo += 1;
      }
      upserted += got; done += 1;
      if (done % 30 === 0 || got === 0) console.log(`[tats] ${done}/${sigungus.length} · ${s.signguNm} ${got}건 · 누적 ${upserted}`);
      await sleep(config.requestDelayMs);
    }
    console.log(`[tats] ✅ 완료 · upsert ${upserted} · 요청 ${requests}`);
  } catch (err) {
    if (err instanceof DailyLimitError) console.warn(`[tats] ⛔ ${err.message}`);
    else { console.error('[tats] 실패:', (err as Error).message); process.exitCode = 1; }
  } finally {
    await pool.end();
  }
}

main();
