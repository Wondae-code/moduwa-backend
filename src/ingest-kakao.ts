// 카카오 로컬(키워드 장소검색)로 POI 보완 — 전화·카테고리·카카오맵 링크.
// TourAPI POI(이름+좌표)를 카카오에 질의 → 가장 가까운 동명 장소 매칭. content_id당 1행.
import { config } from './config';
import { pool, query, withTransaction } from './db';
import { dbl, str, upsertChunked } from './util';

class KakaoQuota extends Error {}
interface Pend { content_id: string; mapx: number | null; mapy: number | null; title: string }

const COLUMNS = [
  'content_id', 'kakao_id', 'place_name', 'category_name', 'category_group_code', 'category_group_name',
  'phone', 'address_name', 'road_address_name', 'kakao_x', 'kakao_y', 'place_url', 'distance', 'matched', 'raw',
];
const MATCH_DIST = 200; // m 이내면 동일 장소로 간주
const cleanQuery = (t: string) => ((t || '').replace(/\([^)]*\)/g, ' ').split('/')[0] ?? '').replace(/\s+/g, ' ').trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchKakao(q: string, x: number | null, y: number | null): Promise<Record<string, unknown>[]> {
  const url = new URL('https://dapi.kakao.com/v2/local/search/keyword.json');
  url.searchParams.set('query', q);
  url.searchParams.set('size', '5');
  if (x != null && y != null) {
    url.searchParams.set('x', String(x));
    url.searchParams.set('y', String(y));
    url.searchParams.set('radius', '2000');
    url.searchParams.set('sort', 'distance');
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `KakaoAK ${config.kakaoRestApiKey}` } });
    if (res.status === 429) throw new KakaoQuota('카카오 일일 쿼터 초과(429)');
    if (res.status === 401) throw new Error('카카오 인증 실패(401) — REST API 키를 확인하세요');
    if (!res.ok) {
      if (attempt < 3) { await sleep(400 * attempt); continue; }
      throw new Error(`HTTP ${res.status}`);
    }
    const j = (await res.json()) as { documents?: Record<string, unknown>[] };
    return j.documents ?? [];
  }
  return [];
}

function toRow(cid: string, best: Record<string, unknown> | null): unknown[] {
  if (!best) return [cid, null, null, null, null, null, null, null, null, null, null, null, null, false, null];
  const dist = best['distance'] != null && best['distance'] !== '' ? Number(best['distance']) : null;
  return [
    cid, str(best['id']), str(best['place_name']), str(best['category_name']),
    str(best['category_group_code']), str(best['category_group_name']), str(best['phone']),
    str(best['address_name']), str(best['road_address_name']), dbl(best['x']), dbl(best['y']),
    str(best['place_url']), dist, dist != null && dist <= MATCH_DIST, JSON.stringify(best),
  ];
}

async function main() {
  if (!config.kakaoRestApiKey) {
    console.error('[kakao] KAKAO_REST_API_KEY 가 없습니다. .env에 카카오 REST API 키를 넣어주세요.');
    await pool.end(); process.exitCode = 1; return;
  }
  const total = (await query<{ n: number }>(`select count(distinct content_id)::int n from kor_poi where content_id is not null`)).rows[0]!.n;
  const done = (await query<{ n: number }>(`select count(*)::int n from kakao_place`)).rows[0]!.n;
  console.log(`[kakao] 고유 장소 ${total} · 완료 ${done} · 남음 ${total - done}`);

  const pend = (await query<Pend>(
    `select distinct on (content_id) content_id, mapx, mapy, title from kor_poi
      where content_id is not null and title is not null and mapx is not null
        and not exists (select 1 from kakao_place k where k.content_id = kor_poi.content_id)
      order by content_id limit ${config.kakaoDailyCap}`,
  )).rows;
  console.log(`[kakao] 이번 실행 ${pend.length}건 · 동시성 ${config.kakaoConcurrency}`);

  const buf: unknown[][] = [];
  let idx = 0, processed = 0, matchedCnt = 0, stop: string | null = null, flushing = false;

  async function flush(force: boolean): Promise<void> {
    if (flushing || (!force && buf.length < 500)) return;
    flushing = true;
    const batch = buf.splice(0, buf.length);
    try {
      await withTransaction((c) => upsertChunked(c, 'kakao_place', COLUMNS, batch, 'content_id'));
      console.log(`[kakao] 진행 ${processed}/${pend.length} · 매칭 ${matchedCnt}`);
    } finally { flushing = false; }
  }

  async function worker(): Promise<void> {
    while (!stop) {
      const i = idx++;
      if (i >= pend.length) return;
      const p = pend[i]!;
      try {
        const docs = await fetchKakao(cleanQuery(p.title), p.mapx, p.mapy);
        const r = toRow(p.content_id, docs[0] ?? null);
        buf.push(r); processed += 1; if (r[13] === true) matchedCnt += 1;
      } catch (e) {
        if (e instanceof KakaoQuota) { stop = 'quota'; return; }
        if (/401/.test((e as Error).message)) { stop = 'auth'; return; }
        buf.push(toRow(p.content_id, null)); processed += 1; // 일시 오류 → 미매칭 기록하고 진행
      }
      if (buf.length >= 500) await flush(false);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, config.kakaoConcurrency) }, worker));
  await flush(true);

  const left = (await query<{ n: number }>(
    `select count(distinct content_id)::int n from kor_poi k where k.content_id is not null
       and not exists (select 1 from kakao_place x where x.content_id=k.content_id)`,
  )).rows[0]!.n;
  const reason = stop === 'auth' ? '인증실패(키 확인)' : stop === 'quota' ? '쿼터초과' : '완료';
  console.log(`[kakao] 종료(${reason}) · 처리 ${processed} · 매칭 ${matchedCnt} (${processed ? Math.round(100 * matchedCnt / processed) : 0}%) · 남음 ${left}`);
  if (stop === 'auth') process.exitCode = 1;
  await pool.end();
}

main().catch(async (e) => { console.error('[kakao] 치명:', e); await pool.end(); process.exitCode = 1; });
