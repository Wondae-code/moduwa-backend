// 지역별 관광 다양성(AreaTarDivService) — 3개 오퍼레이션 × 시도 × 월
//
// ⚠️ **이 스크립트는 지금 쓰지 않는다(2026-09-05 결정).** 돌리면 0건이 나오는데, 그건 데이터가
//    없어서가 아니라 **이 코드가 지표 코드를 안 보내기 때문이다.**
//
//    매뉴얼 v4.0 은 touDivIxCd / expDivIxCd / intlDivIxCd 를 **옵션(0)** 으로 적었지만, 실제로는
//    이 값이 없으면 resultCode 0000(정상)에 totalCount 0 이 온다. 아래 fetchAll 은 areaCd·baseYm
//    만 보내므로 영원히 빈 결과를 받는다. 예전 주석의 "제공기관 미개방" 은 **오진이었다.**
//
//    실제로는 202510~202607(10개월) · 272개 시군구 · 지표 20종이 제공된다.
//    쓰기로 결정하면 fetchAll 에 지표 코드 루프를 넣어야 한다(31/3101~3107, 32/3201~3207,
//    33/3301~3303). signguCd 를 빼면 그 시도의 전 시군구가 한 번에 온다.
//
//    쓰지 않는 이유는 데이터의 성격이다 — 이름은 "다양성" 이지만 상권 규모를 재고(상위 강남·중구,
//    하위 울릉군), 연령별 지표가 전체와 사실상 같은 값이며(r=0.96), 시간에 따라 거의 변하지
//    않는다. 근거와 실측은 docs/applied-apis.md 참고.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, monthRange } from './config';
import { DailyLimitError, fetchApi, isSuccess, type ApiItem } from './client';
import { pool, withTransaction } from './db';
import { ENDPOINT, str, upsertChunked } from './util';

interface Sigungu { areaCd: string }
const here = dirname(fileURLToPath(import.meta.url));
const sigungus = JSON.parse(readFileSync(join(here, 'sigungu-codes.json'), 'utf8')) as Sigungu[];
const SIDO = [...new Set(sigungus.map((s) => s.areaCd))]; // 17개 시도 areaCd
const OPS = ['areaTouDivList', 'areaExpDivList', 'areaIntlDivList'];
const COLUMNS = ['operation', 'area_cd', 'base_ym', 'region_nm', 'raw', 'natural_key'];
const NUM = 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toRow(op: string, areaCd: string, baseYm: string, it: ApiItem): unknown[] {
  const key = `${op}:${areaCd}:${baseYm}:${createHash('sha1').update(JSON.stringify(it)).digest('hex')}`;
  return [op, areaCd, baseYm, str(it['areaNm'] ?? it['regionNm'] ?? it['signguNm']), JSON.stringify(it), key];
}

async function fetchAll(op: string, areaCd: string, baseYm: string): Promise<ApiItem[]> {
  const out: ApiItem[] = [];
  let pageNo = 1, total = Infinity;
  while (pageNo <= total) {
    const res = await fetchApi(`${ENDPOINT.areaTarDiv}/${op}`, { numOfRows: NUM, pageNo, areaCd, baseYm });
    if (!isSuccess(res.resultCode)) throw new Error(`결과코드 ${res.resultCode}: ${res.resultMsg}`);
    if (total === Infinity) total = res.totalCount > 0 ? Math.ceil(res.totalCount / NUM) : pageNo;
    out.push(...res.items);
    if (res.items.length === 0) break;
    pageNo += 1; await sleep(config.requestDelayMs);
  }
  return out;
}

async function main() {
  const months = monthRange(config.baseYmStart, config.baseYmEnd);

  // ── 프로브: 데이터 개방 여부 확인 (최근 2개월 × 시도 3곳) ──
  let hasData = false;
  const probeMonths = months.slice(-2);
  outer: for (const ym of probeMonths) {
    for (const ac of SIDO.slice(0, 3)) {
      const res = await fetchApi(`${ENDPOINT.areaTarDiv}/areaTouDivList`, { numOfRows: 1, pageNo: 1, areaCd: ac, baseYm: ym });
      if (res.totalCount > 0) { hasData = true; break outer; }
    }
  }
  if (!hasData) {
    console.log('[areadiv] 프로브 결과 데이터 미개방(0건) — 수집 생략. 데이터 개방되면 자동 수집됩니다.');
    await pool.end();
    return;
  }

  // ── 데이터 존재 시 전수 수집 ──
  let upserted = 0, requests = 0;
  console.log(`[areadiv] 데이터 감지 → 전수 수집 (${OPS.length}op × ${SIDO.length}시도 × ${months.length}월)`);
  try {
    for (const op of OPS) {
      for (const ac of SIDO) {
        for (const ym of months) {
          if (config.dailyRequestCap > 0 && requests >= config.dailyRequestCap) {
            console.log('[areadiv] 일일 캡 도달 → 중단'); await pool.end(); return;
          }
          const items = await fetchAll(op, ac, ym);
          requests += 1;
          if (items.length > 0) {
            await withTransaction((c) => upsertChunked(c, 'area_tar_div', COLUMNS, items.map((it) => toRow(op, ac, ym, it))));
            upserted += items.length;
          }
          await sleep(config.requestDelayMs);
        }
      }
      console.log(`[areadiv] ${op} 완료 · 누적 ${upserted}`);
    }
    console.log(`[areadiv] ✅ 완료 · upsert ${upserted} · 요청 ${requests}`);
  } catch (err) {
    if (err instanceof DailyLimitError) console.warn(`[areadiv] ⛔ ${err.message}`);
    else { console.error('[areadiv] 실패:', (err as Error).message); process.exitCode = 1; }
  } finally {
    await pool.end();
  }
}

main();
