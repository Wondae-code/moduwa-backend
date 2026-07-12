// 지역 대표 관광지(LocgoHubTarService1) 상세 채우기 — 3단 폴백
//  ①③ 키 없이: TourAPI 소개(kor_detail 재사용) + 카카오/네이버 지도 딥링크(좌표 100%)
//  ②   카카오 키 있으면: 전화·카테고리·place_url 보강
import { config } from './config';
import { pool, query } from './db';
import { dbl, str } from './util';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanQuery = (t: string) => ((t || '').replace(/\([^)]*\)/g, ' ').split('/')[0] ?? '').replace(/\s+/g, ' ').trim();

// ── Step 1 (키 불필요): 지도 딥링크 + TourAPI 소개를 전 지역대표에 채움 ──
async function fillBase(): Promise<void> {
  const res = await query(`
    with hub as (
      select distinct on (hub_tats_cd)
        hub_tats_cd, hub_tats_nm, area_cd, signgu_cd, map_x, map_y
      from locgo_hub_records
      where hub_tats_nm <> '' and map_x is not null and map_y is not null
      order by hub_tats_cd, base_ym desc
    ),
    det as (   -- 이름별 대표 TourAPI 상세 1건 (kor_detail 재사용, 사진·소개가 있는 행 우선)
      select distinct on (p.title)
        p.title, dd.overview, dd.homepage, dd.intro_raw->>'usetime' as usetime,
        nullif(dd.common_raw->>'firstimage','')  as firstimage,
        nullif(dd.common_raw->>'firstimage2','') as firstimage2,
        nullif(dd.common_raw->>'cpyrhtDivCd','')  as image_copyright
      from kor_poi p join kor_detail dd on dd.content_id = p.content_id
      where p.service = 'kor'
      order by p.title,
        (nullif(dd.common_raw->>'firstimage','') is not null) desc,
        (dd.overview is not null) desc
    )
    insert into locgo_hub_detail
      (hub_tats_cd, hub_tats_nm, area_cd, signgu_cd, map_x, map_y,
       map_url_kakao, map_url_naver, overview, usetime, homepage,
       firstimage, firstimage2, image_copyright, detail_source)
    select
      h.hub_tats_cd, h.hub_tats_nm, h.area_cd, h.signgu_cd, h.map_x, h.map_y,
      'https://map.kakao.com/link/map/' || replace(h.hub_tats_nm, ',', ' ') || ',' || h.map_y || ',' || h.map_x,
      'https://map.naver.com/v5/search/' || h.hub_tats_nm,
      det.overview, det.usetime, det.homepage,
      det.firstimage, det.firstimage2, det.image_copyright,
      case when det.overview is not null then 'tourapi' else 'map-only' end
    from hub h left join det on det.title = h.hub_tats_nm
    on conflict (hub_tats_cd) do update set
      hub_tats_nm   = excluded.hub_tats_nm,
      map_x = excluded.map_x, map_y = excluded.map_y,
      map_url_kakao = excluded.map_url_kakao, map_url_naver = excluded.map_url_naver,
      overview = excluded.overview, usetime = excluded.usetime, homepage = excluded.homepage,
      firstimage = excluded.firstimage, firstimage2 = excluded.firstimage2,
      image_copyright = excluded.image_copyright,
      detail_source = case
        when excluded.overview is not null then 'tourapi'
        when locgo_hub_detail.place_url is not null then 'kakao'
        else 'map-only' end,
      updated_at = now()
  `);
  console.log(`[locgo-detail] ①③ 기본 채움 완료 · 영향 행 ${res.rowCount}`);
}

// ── Step 2 (카카오 키 필요): 전화·카테고리·place_url 보강 ──
async function fetchKakao(q: string, x: number | null, y: number | null): Promise<Record<string, unknown> | null> {
  const url = new URL('https://dapi.kakao.com/v2/local/search/keyword.json');
  url.searchParams.set('query', q);
  url.searchParams.set('size', '5');
  if (x != null && y != null) {
    url.searchParams.set('x', String(x)); url.searchParams.set('y', String(y));
    url.searchParams.set('radius', '2000'); url.searchParams.set('sort', 'distance');
  }
  const res = await fetch(url, { headers: { Authorization: `KakaoAK ${config.kakaoRestApiKey}` } });
  if (res.status === 429) throw new Error('KAKAO_QUOTA');
  if (res.status === 401) throw new Error('KAKAO_AUTH');
  if (!res.ok) return null;
  const j = (await res.json()) as { documents?: Record<string, unknown>[] };
  return j.documents?.[0] ?? null;
}

async function enrichKakao(): Promise<void> {
  const cap = config.kakaoDailyCap;
  const pend = (await query<{ hub_tats_cd: string; hub_tats_nm: string; map_x: number; map_y: number }>(
    `select hub_tats_cd, hub_tats_nm, map_x, map_y from locgo_hub_detail
      where place_url is null order by hub_tats_cd limit ${cap}`,
  )).rows;
  console.log(`[locgo-detail] ② 카카오 보강 대상 ${pend.length}건 · 동시성 ${config.kakaoConcurrency}`);

  let idx = 0, done = 0, matched = 0, stop: string | null = null;
  const buf: Array<[string, string | null, string | null, string | null]> = [];

  async function flush(): Promise<void> {
    if (buf.length === 0) return;
    const rows = buf.splice(0, buf.length);
    // 개별 UPDATE 대신 값 목록으로 일괄 반영
    for (const [cd, phone, category, place_url] of rows) {
      await query(
        `update locgo_hub_detail set phone=$2::text, category=$3::text, place_url=$4::text,
           detail_source = case when overview is not null then 'tourapi'
                                when $4::text is not null then 'kakao' else detail_source end,
           updated_at=now() where hub_tats_cd=$1::text`,
        [cd, phone, category, place_url],
      );
    }
  }

  async function worker(): Promise<void> {
    while (!stop) {
      const i = idx++; if (i >= pend.length) return;
      const p = pend[i]!;
      try {
        const doc = await fetchKakao(cleanQuery(p.hub_tats_nm), p.map_x, p.map_y);
        buf.push([p.hub_tats_cd, str(doc?.['phone']), str(doc?.['category_name']), str(doc?.['place_url'])]);
        done += 1; if (doc?.['place_url']) matched += 1;
      } catch (e) {
        const m = (e as Error).message;
        if (m === 'KAKAO_QUOTA') { stop = 'quota'; return; }
        if (m === 'KAKAO_AUTH') { stop = 'auth'; return; }
        buf.push([p.hub_tats_cd, null, null, null]); done += 1;
      }
      if (buf.length >= 100) { await flush(); console.log(`[locgo-detail] ② ${done}/${pend.length} · 매칭 ${matched}`); }
      await sleep(20);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, config.kakaoConcurrency) }, worker));
  await flush();
  console.log(`[locgo-detail] ② 종료(${stop ?? '완료'}) · 처리 ${done} · 매칭 ${matched}`);
}

async function main() {
  await fillBase();

  const summary = await query<{ detail_source: string; n: number }>(
    `select detail_source, count(*)::int n from locgo_hub_detail group by detail_source order by n desc`,
  );
  console.log('[locgo-detail] 소스별 현황:', Object.fromEntries(summary.rows.map((r) => [r.detail_source, r.n])));

  if (config.kakaoRestApiKey) {
    await enrichKakao();
  } else {
    console.log('[locgo-detail] ② 카카오 키 없음 — 전화·카테고리 보강 생략(지도 링크는 이미 100% 채워짐). 키 넣으면 자동 합류.');
  }
  await pool.end();
}

main().catch(async (e) => { console.error('[locgo-detail] 치명:', e); await pool.end(); process.exitCode = 1; });
