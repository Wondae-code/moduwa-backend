// 지역별 관광 다양성(AreaTarDivService) — 3개 오퍼레이션 × 시도 × 월
// ⚠️ 현재 제공기관 데이터 미개방(전 조합 0건). 프로브로 먼저 확인 후, 데이터 있으면 전수 수집.
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
