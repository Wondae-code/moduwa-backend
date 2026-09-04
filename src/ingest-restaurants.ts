// 관광식당(행안부 식품_관광식당 조회서비스) 수집 — 526 레코드 → 사업장 218곳.
//
// 다른 ingest 와 달리 KTO 가 아니라 행안부 API 라 두 가지가 다르다:
//  ① 응답 봉투는 같지만(response.body.items.item[]) 필드가 인허가(LOCALDATA) 형식이다(대문자 스네이크).
//  ② `_type=json` 이 아니라 `type=json` 을 받는다. 그래서 공용 fetchApi 를 쓰지 않고 여기서 직접 부른다.
//
// ⚠️ **API 가 사업장이 아니라 갱신 이력을 준다.** MNG_NO 가 중복되고 DAT_UPDT_SE 가 I/U 다.
//    사업장별로 DAT_UPDT_PNT 가 가장 최근인 레코드만 남긴다 — 안 하면 같은 업소가 여러 번
//    들어가고 옛 영업상태가 최신 값을 덮을 수 있다.
//
// ⚠️ **원본 좌표를 쓰지 않는다.** 투영좌표계인데 원점이 어느 표준 정의와도 맞지 않는다(050 주석).
//    주소를 카카오로 지오코딩해 WGS84 를 얻는다. 실측 성공률은 표본 40/40 이었다.
import { config } from './config';
import { pool, withTransaction } from './db';
import { dbl, str, upsertChunked } from './util';

const ENDPOINT = 'https://apis.data.go.kr/1741000/tourist_restaurants/info';
const PAGE = 100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Item = Record<string, unknown>;

/** 행안부 API 는 type=json (KTO 의 _type 이 아니다). */
async function fetchPage(pageNo: number): Promise<{ items: Item[]; totalCount: number }> {
  if (!config.serviceKey) throw new Error('DATA_GO_KR_SERVICE_KEY 가 비어 있습니다.');
  const url = new URL(ENDPOINT);
  url.searchParams.set('serviceKey', config.serviceKey);
  url.searchParams.set('pageNo', String(pageNo));
  url.searchParams.set('numOfRows', String(PAGE));
  url.searchParams.set('type', 'json');

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      const text = await res.text();
      // 한도초과·장애는 XML 봉투로 온다 — JSON 파싱 전에 걸러 원인을 알 수 있게 한다.
      if (!text.trim().startsWith('{')) {
        throw new Error(`JSON 이 아닌 응답: ${text.slice(0, 160)}`);
      }
      const body = (JSON.parse(text) as { response?: { body?: Record<string, unknown> } }).response?.body ?? {};
      const raw = (body['items'] as { item?: Item | Item[] } | undefined)?.item;
      const items = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
      return { items, totalCount: Number(body['totalCount'] ?? 0) };
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(500 * attempt);
    }
  }
  return { items: [], totalCount: 0 };
}

// ── 지오코딩 ────────────────────────────────────────────────────────────────
//
//  주소 뒤에 붙는 건물·층 정보(", 2층 (동선동1가)")를 떼야 카카오가 찾는다. 그걸 붙인 채로
//  질의하면 표본에서 25% 가 실패했고, 떼면 40/40 성공했다.
const cleanAddr = (a: string | null): string => (String(a ?? '').split(',')[0] ?? '').trim();

/**
 * 광역 지자체 이름을 카카오가 아는 표기로 바꾼다.
 *
 * ⚠️ 원본에 "전남광주통합특별시" 처럼 통합 표기가 들어 있어 그대로는 못 찾는다. 시군구 이름만
 *    남기면 카카오가 해결하므로, 아는 표기가 아니면 **첫 토큰을 떼는 쪽**을 폴백으로 둔다.
 */
const dropFirstToken = (a: string): string => a.split(' ').slice(1).join(' ').trim();

/**
 * 지번주소에서 건물명만 뽑는다 — "역삼동 GS강남타워 지하1층" → "GS강남타워".
 *
 * ⚠️ 원본의 지번주소에 번지 대신 **건물명**이 든 경우가 있다(강남 오피스 빌딩 지하 매장 등).
 *    그런 주소는 카카오 주소검색이 못 찾지만, 건물명으로 장소검색을 하면 찾는다 — 실측으로
 *    실패 4곳 중 3곳이 이 경로로 해결됐다. 층수 표기는 떼야 한다.
 */
const buildingName = (a: string): string => {
  const t = a.split(' ');
  const i = t.findIndex((x) => /[동리가]$/.test(x));
  if (i < 0) return '';
  return t.slice(i + 1)
    .filter((x) => !/^지하/.test(x) && !/^\d+층$/.test(x) && !/^\d+$/.test(x))
    .join(' ').trim();
};

/** 법인 형태 표기를 떼고 상호만 남긴다 — 장소검색은 "(주)" 가 붙으면 못 찾는 경우가 많다. */
const cleanName = (n: string): string =>
  n.replace(/\(주\)|주식회사|㈜/g, ' ').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();

type Geo = { lat: number; lon: number; source: string; matched: string };

async function kakao(path: 'address' | 'keyword', query: string): Promise<Geo | null> {
  if (!query) return null;
  const url = new URL(`https://dapi.kakao.com/v2/local/search/${path}.json`);
  url.searchParams.set('query', query);
  url.searchParams.set('size', '1');
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `KakaoAK ${config.kakaoRestApiKey}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 429) throw new Error('카카오 일일 쿼터 초과(429)');
    if (res.status === 401) throw new Error('카카오 인증 실패(401) — KAKAO_REST_API_KEY 확인');
    if (!res.ok) {
      if (attempt < 3) { await sleep(400 * attempt); continue; }
      return null;
    }
    const j = (await res.json()) as { documents?: Record<string, unknown>[] };
    const d = (j.documents ?? [])[0];
    if (!d) return null;
    const lat = Number(d['y']), lon = Number(d['x']);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const matched = String(
      d['road_address_name'] || d['address_name']
      || (d['road_address'] as Record<string, unknown> | undefined)?.['address_name']
      || (d['address'] as Record<string, unknown> | undefined)?.['address_name'] || '',
    );
    return { lat, lon, source: path, matched };
  }
  return null;
}

/**
 * 주소 → WGS84. 단계적으로 물러나며 시도한다.
 *
 * 순서에 의미가 있다 — 도로명 주소가 가장 정확하고, 지번은 그다음, 이름 검색은 마지막이다.
 * 이름 검색을 먼저 하면 동명 업소를 엉뚱한 도시에서 집어올 수 있다.
 */
async function geocode(it: Item): Promise<Geo | null> {
  const road = cleanAddr(str(it['ROAD_NM_ADDR']));
  const lot = cleanAddr(str(it['LOTNO_ADDR']));
  const name = str(it['BPLC_NM']) ?? '';
  const city = (road || lot).split(' ').slice(0, 2).join(' ');

  const tries: [Parameters<typeof kakao>[0], string, string][] = [
    ['address', road, 'road'],
    ['address', dropFirstToken(road), 'road-no-region'],
    ['address', lot, 'lot'],
    ['address', dropFirstToken(lot), 'lot-no-region'],
    // 지번 자리에 건물명이 든 주소 — 실패 4곳 중 3곳이 여기서 해결됐다.
    ['keyword', `${city} ${buildingName(lot)}`.trim(), 'building'],
    // 마지막 수단 — 시군구를 함께 넣어 동명 업소를 다른 도시에서 집지 않게 한다.
    ['keyword', `${city} ${cleanName(name)}`.trim(), 'keyword'],
  ];
  for (const [path, q, label] of tries) {
    // ⚠️ 질의가 시군구만 남으면 건너뛴다. 그대로 물으면 카카오가 **시군구 중심 좌표**를
    //    돌려주는데, 그건 그 업소의 위치가 아니라 조용히 틀린 좌표다.
    if (!q || q === city) continue;
    const g = await kakao(path, q);
    await sleep(60);   // 카카오 초당 제한 여유 (218건이라 총 지연은 무시할 수준)
    if (g) return { ...g, source: label };
  }
  return null;
}

// ── 적재 ────────────────────────────────────────────────────────────────────

//  ⚠️ 좌표 컬럼(lat·lon·geocode_*)은 **여기 없다.** upsert 가 매번 모든 컬럼을 덮으므로,
//     지오코딩하지 않은 업소의 기존 좌표를 지워 버린다. 좌표는 별도 update 로 쓴다(main 참고).
const COLUMNS = [
  'mng_no', 'name', 'road_addr', 'lot_addr', 'zipcode', 'tel', 'biz_type',
  'sales_status', 'sales_status_detail', 'closed_date', 'licensed_date',
  'eng_name', 'facility_size', 'raw',
];

/** 빈 문자열은 날짜로 못 넣는다 — null 로 바꿔야 insert 가 통과한다. */
const date = (v: unknown): string | null => {
  const s = str(v);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

function toRow(it: Item): unknown[] {
  return [
    str(it['MNG_NO']), str(it['BPLC_NM']) ?? '(이름 없음)',
    str(it['ROAD_NM_ADDR']), str(it['LOTNO_ADDR']), str(it['ROAD_NM_ZIP']),
    str(it['TELNO']), str(it['CULTR_SPTS_TPBIZ_NM']),
    str(it['SALS_STTS_NM']), str(it['DTL_SALS_STTS_NM']),
    date(it['CLSBIZ_YMD']), date(it['LCPMT_YMD']),
    str(it['ENG_CONM_NM']), dbl(it['FCLT_SCL']),
    JSON.stringify(it),
  ];
}

async function main() {
  const onlyMissing = process.argv.includes('--geocode-missing');
  console.log('[rest] 관광식당 수집 시작');

  // ① 전량 수집
  let all: Item[] = [];
  let pageNo = 1;
  let totalCount = Infinity;
  while (all.length < totalCount) {
    const { items, totalCount: tc } = await fetchPage(pageNo);
    if (totalCount === Infinity) {
      totalCount = tc;
      console.log(`[rest] 총 ${tc} 레코드 · 페이지 ${Math.ceil(tc / PAGE)}개`);
    }
    if (items.length === 0) break;
    all = all.concat(items);
    pageNo += 1;
  }
  console.log(`[rest] 레코드 ${all.length}건 수신`);

  // ② 사업장별 최신 레코드만 (파일 상단 주석)
  const latest = new Map<string, Item>();
  for (const it of all) {
    const key = String(it['MNG_NO'] ?? '');
    if (!key) continue;
    const prev = latest.get(key);
    if (!prev || String(it['DAT_UPDT_PNT'] ?? '') > String(prev['DAT_UPDT_PNT'] ?? '')) {
      latest.set(key, it);
    }
  }
  const biz = [...latest.values()];
  const open = biz.filter((x) => x['SALS_STTS_NM'] === '영업/정상' && !str(x['CLSBIZ_YMD']));
  console.log(`[rest] 사업장 ${biz.length}곳 (영업중 ${open.length} · 폐업/기타 ${biz.length - open.length})`);

  // ③ 지오코딩 — **영업중만** 한다. 폐업 업소의 좌표는 쓸 일이 없고 쿼터를 쓴다.
  const known = onlyMissing
    ? new Set((await pool.query<{ mng_no: string }>(
        'select mng_no from tourist_restaurants where lat is not null')).rows.map((r) => r.mng_no))
    : new Set<string>();

  const geos = new Map<string, Geo | null>();
  let ok = 0, fail = 0;
  for (const it of open) {
    const key = String(it['MNG_NO']);
    if (known.has(key)) continue;
    try {
      const g = await geocode(it);
      geos.set(key, g);
      if (g) ok += 1;
      else { fail += 1; console.log(`[rest] 좌표 실패: ${str(it['BPLC_NM'])} — ${str(it['ROAD_NM_ADDR'])}`); }
    } catch (err) {
      // 쿼터 초과 등은 여기서 멈춘다 — 남은 것은 다음 실행에서 --geocode-missing 로 이어간다.
      console.error(`[rest] 지오코딩 중단: ${(err as Error).message}`);
      break;
    }
  }
  console.log(`[rest] 지오코딩 성공 ${ok} · 실패 ${fail}`);

  // ④ upsert. 폐업 업소도 넣는다(050 주석) — 좌표만 없다.
  //
  //  ⚠️ **좌표를 null 로 덮지 않는다.** upsertChunked 는 모든 컬럼을 excluded 값으로 덮는데,
  //     이번 실행에서 지오코딩하지 않은 업소는 geo 가 null 이라 **이미 있던 좌표가 지워진다.**
  //     실제로 --geocode-missing 첫 실행에서 138곳의 좌표가 날아갔다. 그래서 좌표 컬럼은
  //     공용 헬퍼에 맡기지 않고, 새 값이 있을 때만 따로 갱신한다.
  const rows = biz.map((it) => toRow(it));
  const n = await withTransaction((client) =>
    upsertChunked(client, 'tourist_restaurants', COLUMNS, rows, 'mng_no'));

  let geoWritten = 0;
  for (const [mngNo, g] of geos) {
    if (!g) continue;
    await pool.query(
      `update tourist_restaurants
          set lat = $2, lon = $3, geocode_source = $4, geocode_matched = $5,
              geocoded_at = now(), updated_at = now()
        where mng_no = $1`,
      [mngNo, g.lat, g.lon, g.source, g.matched],
    );
    geoWritten += 1;
  }
  console.log(`[rest] upsert ${n}건 · 좌표 갱신 ${geoWritten}건`);
  await pool.end();
}

main().catch(async (err) => {
  console.error('[rest] 실패:', err);
  await pool.end().catch(() => {});
  process.exit(1);
});
