// moduwa 관광 데이터 REST API — Hono
//  조회는 전부 읽기 전용. 예외적으로 리뷰(POST /v1/reviews)만 쓰기를 허용한다.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { config } from '../config';
import { type PartyKind, type RecommendInput, recommend } from './recommend';
import { query, withTransaction } from '../db';
import { buildDashboard } from './dashboard';
import { buildAuthRoutes } from './auth-routes';
import type { AppEnv } from './middleware';
import { apiKeyAuth, rateLimit, sessionAuth } from './middleware';

// ── 후기 사진 저장 ────────────────────────────────────────────────────────────
//  파일명은 내용의 sha256. 같은 사진을 두 번 올려도 한 번만 저장되고 이름이 충돌하지
//  않으며, 내용이 곧 이름이므로 캐시를 영구(immutable)로 걸 수 있다.
//  해시를 두 단계 디렉터리로 쪼개는 것은 한 폴더에 파일이 수만 개 쌓이는 것을 피하기 위함.
const IMAGE_TYPES = [
  { ext: 'jpg', mime: 'image/jpeg', match: (b: Buffer) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', mime: 'image/png', match: (b: Buffer) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  // HEIC: 4~8바이트가 'ftyp', 그 뒤 브랜드가 heic/heix/hevc/mif1
  {
    ext: 'heic',
    mime: 'image/heic',
    match: (b: Buffer) => b.subarray(4, 8).toString('latin1') === 'ftyp'
      && ['heic', 'heix', 'hevc', 'mif1'].includes(b.subarray(8, 12).toString('latin1')),
  },
] as const;

/** 확장자·Content-Type 을 믿지 않고 실제 바이트로 판별한다. 이미지가 아니면 null. */
function sniffImage(buf: Buffer): { ext: string; mime: string } | null {
  if (buf.length < 12) return null;
  const hit = IMAGE_TYPES.find((t) => t.match(buf));
  return hit ? { ext: hit.ext, mime: hit.mime } : null;
}

function imagePathFor(name: string): string {
  // 해시 기반이라 이름에 경로 문자가 들어올 수 없지만, 외부 입력이므로 형식을 강제한다.
  return join(config.api.uploadDir, 'reviews', name.slice(0, 2), name.slice(2, 4), name);
}

// 페이지네이션 파라미터 파싱 (limit 1~100, offset ≥0)
function paging(c: { req: { query: (k: string) => string | undefined } }): { limit: number; offset: number } {
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 20) || 20));
  const offset = Math.max(0, Number(c.req.query('offset') ?? 0) || 0);
  return { limit, offset };
}

export function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const origins = config.api.allowedOrigins;
  app.use('*', cors({
    origin: origins.includes('*') || origins.length === 0 ? '*' : origins,
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], // 쓰기: 후기(POST) · 플랜(PUT/DELETE)
    // x-session-token: 사용자 로그인 세션. authorization 은 이미 API 키가 쓰고 있어 겹칠 수 없다.
    allowHeaders: ['authorization', 'x-api-key', 'x-session-token', 'content-type'],
  }));

  // 공개 엔드포인트 (인증 불필요)
  app.get('/', (c) => c.json({
    name: 'moduwa tourism data API',
    version: '1',
    docs: 'GET /v1/* (요청 헤더에 Authorization: Bearer <API_KEY> 필요)',
    endpoints: [
      'GET /health',
      'GET /v1/pet-friendly?region=&sigungu=&type=&petArea=&guideDog=&q=&limit=&offset=',
      'GET /v1/pet-friendly/:contentId',
      'GET /v1/attractions?sigungu=&source=&q=&limit=&offset=',
      'GET /v1/attractions/:hubTatsCd',
      'GET /v1/barrier-free?type=&region=&sigungu=&q=&hasImage=&hasAccess=&limit=&offset=',
      'GET /v1/barrier-free/:contentId',
      'GET /v1/barrier-free/:contentId/related?limit=',
      'GET /v1/search?q=&limit=&offset=',
      'GET /v1/reviews?sort=recommended|likes|latest&contentId=&hasImage=&limit=&offset=',
      'GET /v1/reviews/summary?contentId=',
      'GET /v1/review-tags',
      '🔒 POST /v1/reviews  {contentId?, locationNm, rating, body, authorNm?, tags?, wouldRevisit?, imageURLs?}',
      '🔒 POST /v1/reviews/:reviewId/comments  {body, authorNm?}',
      '🔒 POST /v1/plans/recommend  {region|regionCode, startDate, endDate, party?, themes?, budget?, dayTripOnly?}',
      '🔒 GET /v1/plans',
      '🔒 GET /v1/plans/:planId',
      '🔒 PUT /v1/plans/:planId  {authorNm?, title, startDate, endDate, region?, party?, themes?, budget?, dayTripOnly?, coverImageURL?, days[]}',
      '🔒 DELETE /v1/plans/:planId',
      '🔒 GET /v1/saved-places',
      '🔒 PUT /v1/saved-places/:contentId',
      '🔒 DELETE /v1/saved-places/:contentId',
      'GET /v1/posts?mine=&liked=&contentId=&limit=&offset=  (mine·liked 는 🔒)',
      'GET /v1/posts/:postId',
      '🔒 POST /v1/posts  {body, authorNm?, imageURLs?, places?, accessFeatures?}',
      '🔒 DELETE /v1/posts/:postId',
      '🔒 PUT /v1/posts/:postId/like',
      '🔒 DELETE /v1/posts/:postId/like',
      '🔒 PUT /v1/reviews/:reviewId/like',
      '🔒 DELETE /v1/reviews/:reviewId/like',
      'GET /v1/posts/:postId/comments',
      '🔒 POST /v1/posts/:postId/comments  {body, authorNm?}',
      '',
      'POST /v1/auth/google · /v1/auth/apple · /v1/auth/kakao  {idToken, deviceId?, nickname?, accessFeatures?}',
      '',
      '🔒 = X-Session-Token 필요. POST /v1/auth/email/sign-up · sign-in 으로 발급.',
      ...(config.dashboard.password ? ['GET /dashboard  (수집 현황 대시보드 — 비밀번호 로그인)'] : []),
    ],
    source: '한국관광공사 TourAPI · data.go.kr (출처 표시 필요)',
  }));

  // 업로드된 후기 사진 서빙 — **인증 없이** 연다.
  //  iOS 의 AsyncImage 는 Authorization 헤더를 붙이지 않으므로 /v1/* 아래 두면 이미지가
  //  전부 401 이 된다. 후기 사진은 앱에 공개로 노출되는 콘텐츠이고 파일명이 sha256 이라
  //  URL 을 모르면 접근할 수 없다.
  app.get('/images/reviews/:name', async (c) => {
    const name = c.req.param('name');
    // 해시 기반 이름만 허용 — 경로 조작(../)을 원천 차단한다.
    if (!/^[0-9a-f]{64}\.(jpg|png|heic)$/.test(name)) {
      return c.json({ error: 'not_found' }, 404);
    }
    const ext = name.split('.').pop()!;
    const mime = IMAGE_TYPES.find((t) => t.ext === ext)?.mime ?? 'application/octet-stream';
    try {
      const buf = await readFile(imagePathFor(name));
      return c.body(new Uint8Array(buf), 200, {
        'Content-Type': mime,
        // 내용이 곧 이름이라 같은 URL 의 내용은 절대 바뀌지 않는다.
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
    } catch {
      return c.json({ error: 'not_found' }, 404);
    }
  });
  app.get('/health', async (c) => {
    try {
      await query('select 1');
      return c.json({ status: 'ok', db: 'up' });
    } catch {
      return c.json({ status: 'degraded', db: 'down' }, 503);
    }
  });

  // 이하 /v1/* 은 인증 + 레이트리밋 적용
  const v1 = new Hono<AppEnv>();
  v1.use('*', apiKeyAuth);
  v1.use('*', rateLimit);
  // 사용자 신원 해석. 토큰이 없으면 통과시키므로 익명 요청은 종전대로 동작한다.
  //  ⚠️ apiKeyAuth 뒤에 둔다 — API 키도 없는 요청에 DB 를 치지 않기 위함이다.
  v1.use('*', sessionAuth);

  // ── 계정(024·028·029) ───────────────────────────────────────────────────────
  v1.route('/auth', buildAuthRoutes());

  const PET_COLS = `contentid, title, contenttypeid, addr1, addr2, tel, mapx, mapy,
    firstimage, firstimage2, ldong_regn_cd, ldong_signgu_cd,
    pet_allowed, pet_area, pet_species, pet_need, pet_etc,
    guide_dog_allowed, guide_dog_raw, overview, usetime`;

  // 반려동물 동반 가능 관광지 목록
  v1.get('/pet-friendly', async (c) => {
    const { limit, offset } = paging(c);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (cond: string, val: unknown) => { params.push(val); where.push(cond.replace('?', `$${params.length}`)); };

    const region = c.req.query('region');       if (region) add('ldong_regn_cd = ?', region);
    const sigungu = c.req.query('sigungu');      if (sigungu) add('ldong_signgu_cd = ?', sigungu);
    const type = c.req.query('type');            if (type) add('contenttypeid = ?', type);
    const petArea = c.req.query('petArea');      if (petArea) add('pet_area = ?', petArea);
    const guideDog = c.req.query('guideDog');    if (guideDog === 'true') where.push('guide_dog_allowed');
    const q = c.req.query('q');                  if (q) add('title ilike ?', `%${q}%`);

    const wsql = where.length ? `where ${where.join(' and ')}` : '';
    const total = (await query<{ n: number }>(`select count(*)::int n from pet_friendly_view ${wsql}`, params)).rows[0]!.n;
    const rows = (await query(
      `select ${PET_COLS} from pet_friendly_view ${wsql} order by contentid limit ${limit} offset ${offset}`, params,
    )).rows;
    return c.json({ total, limit, offset, count: rows.length, items: rows });
  });

  v1.get('/pet-friendly/:contentId', async (c) => {
    const id = c.req.param('contentId');
    const rows = (await query(`select ${PET_COLS} from pet_friendly_view where contentid = $1`, [id])).rows;
    if (rows.length === 0) return c.json({ error: 'not_found' }, 404);
    return c.json(rows[0]);
  });

  const ATTR_COLS = `hub_tats_cd, hub_tats_nm, area_cd, signgu_cd, map_x, map_y,
    map_url_kakao, map_url_naver, overview, usetime, homepage, phone, category, place_url,
    firstimage, firstimage2, image_copyright, detail_source`;

  // 지역 대표 관광지(상세) 목록
  v1.get('/attractions', async (c) => {
    const { limit, offset } = paging(c);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (cond: string, val: unknown) => { params.push(val); where.push(cond.replace('?', `$${params.length}`)); };

    const sigungu = c.req.query('sigungu');   if (sigungu) add('signgu_cd = ?', sigungu);
    const source = c.req.query('source');     if (source) add('detail_source = ?', source);
    const q = c.req.query('q');               if (q) add('hub_tats_nm ilike ?', `%${q}%`);

    const wsql = where.length ? `where ${where.join(' and ')}` : '';
    const total = (await query<{ n: number }>(`select count(*)::int n from locgo_hub_detail ${wsql}`, params)).rows[0]!.n;
    const rows = (await query(
      `select ${ATTR_COLS} from locgo_hub_detail ${wsql} order by hub_tats_cd limit ${limit} offset ${offset}`, params,
    )).rows;
    return c.json({ total, limit, offset, count: rows.length, items: rows });
  });

  v1.get('/attractions/:hubTatsCd', async (c) => {
    const id = c.req.param('hubTatsCd');
    const rows = (await query(`select ${ATTR_COLS} from locgo_hub_detail where hub_tats_cd = $1`, [id])).rows;
    if (rows.length === 0) return c.json({ error: 'not_found' }, 404);
    return c.json(rows[0]);
  });

  // 무장애(접근성) 장소 — 28속성 전부 노출
  const BF_COLS = `contentid, title, contenttypeid, addr1, addr2, mapx, mapy, firstimage, firstimage2,
    ldong_regn_cd, ldong_signgu_cd,
    parking, route, publictransport, ticketoffice, promotion, wheelchair, exit, elevator, restroom,
    auditorium, room, handicapetc,
    braileblock, helpdog, guidehuman, audioguide, bigprint, brailepromotion, guidesystem, blindhandicapetc,
    signguide, videoguide, hearingroom, hearinghandicapetc,
    stroller, lactationroom, babysparechair, infantsfamilyetc,
    has_image, has_access,
    access_wheelchair, access_visual, access_hearing, access_infant, access_elderly`;

  // 무장애 28속성 중 몇 개가 채워져 있는지. 값은 전부 자유 텍스트고 빈 문자열 없이 null 뿐이라
  // null 여부만 세면 된다. 정보가 풍부한 장소일수록 접근성 판단에 쓸모가 있으므로 기본 정렬 키다.
  const ACCESS_SCORE = `(
    (parking is not null)::int + (route is not null)::int + (publictransport is not null)::int
  + (ticketoffice is not null)::int + (promotion is not null)::int + (wheelchair is not null)::int
  + (exit is not null)::int + (elevator is not null)::int + (restroom is not null)::int
  + (auditorium is not null)::int + (room is not null)::int + (handicapetc is not null)::int
  + (braileblock is not null)::int + (helpdog is not null)::int + (guidehuman is not null)::int
  + (audioguide is not null)::int + (bigprint is not null)::int + (brailepromotion is not null)::int
  + (guidesystem is not null)::int + (blindhandicapetc is not null)::int
  + (signguide is not null)::int + (videoguide is not null)::int + (hearingroom is not null)::int
  + (hearinghandicapetc is not null)::int
  + (stroller is not null)::int + (lactationroom is not null)::int
  + (babysparechair is not null)::int + (infantsfamilyetc is not null)::int)`;

  /**
   * 접근성 그룹 이름 → 컬럼(015). 앱의 `AccessibilityFeature` 중 **서버가 아는 것만** 있다.
   *
   * ⚠️ 이 주석은 예전에 "관광공사 원본에 고령자 축이 없다" 고 적혀 있었는데 **틀린 말이었다.**
   * 열린관광의 공식 분류는 5개 유형이고 다섯째가 고령자다(037 주석). 컬럼 이름에 elder 가
   * 없어서 없다고 판단했을 뿐, 데이터는 wheelchair 컬럼에 들어 있었다.
   * 지금은 access_elderly 로 계산해 다른 넷과 나란히 쓴다.
   */
  const ACCESS_GROUP_COLUMNS: Record<string, string> = {
    wheelchair: 'access_wheelchair',
    visual: 'access_visual',
    hearing: 'access_hearing',
    infant: 'access_infant',
    elderly: 'access_elderly',
  };

  /**
   * 그룹별로 **그 축의 속성이 몇 개나 채워졌는지**. 28속성을 네 그룹으로 나눈 것이다
   * (ACCESS_SCORE 와 같은 목록, 같은 순서).
   *
   * 왜 필요한가: `access=` 로 후보를 좁혀도 **첫 페이지가 그대로였다.** 기본 정렬이 28속성
   * 전체 개수라, 속성을 가장 많이 채운 대형 시설은 어느 그룹 조건에도 다 걸려 어떤 부분집합에도
   * 남는다 — 숙소에서 후보가 1,060 → 190 으로 줄어도 상위 6곳이 한 곳도 바뀌지 않았다
   * (2026-08-22 측정). 사용자에게는 필터가 고장난 것으로 보인다.
   *
   * 그래서 필터가 걸리면 **고른 축의 충실도**를 첫 정렬 키로 쓴다. "유아 동반"을 고르면
   * 유아 관련 4속성이 다 채워진 곳이 먼저 온다 — 그게 그 사람이 물은 질문이다.
   * 전체 개수는 두 번째 키로 남는다(같은 충실도면 정보가 풍부한 곳이 낫다).
   */
  const ACCESS_GROUP_SCORES: Record<string, string> = {
    wheelchair: `((parking is not null)::int + (route is not null)::int + (publictransport is not null)::int
      + (ticketoffice is not null)::int + (promotion is not null)::int + (wheelchair is not null)::int
      + (exit is not null)::int + (elevator is not null)::int + (restroom is not null)::int
      + (auditorium is not null)::int + (room is not null)::int + (handicapetc is not null)::int)`,
    visual: `((braileblock is not null)::int + (helpdog is not null)::int + (guidehuman is not null)::int
      + (audioguide is not null)::int + (bigprint is not null)::int + (brailepromotion is not null)::int
      + (guidesystem is not null)::int + (blindhandicapetc is not null)::int)`,
    hearing: `((signguide is not null)::int + (videoguide is not null)::int
      + (hearingroom is not null)::int + (hearinghandicapetc is not null)::int)`,
    infant: `((stroller is not null)::int + (lactationroom is not null)::int
      + (babysparechair is not null)::int + (infantsfamilyetc is not null)::int)`,
    // 고령자는 전용 속성 묶음이 없어 판정에 쓴 네 항목을 그대로 센다(037).
    //  다른 그룹과 달리 지체 축과 속성이 겹치는데, 그래도 되는 이유는 이 점수가
    //  "고른 축의 충실도" 일 뿐 배타적 분류가 아니기 때문이다.
    elderly: `((wheelchair is not null)::int + (elevator is not null)::int
      + (parking is not null)::int
      + (handicapetc ~ '이동보조|전동스쿠터|스쿠터|보행보조')::int)`,
  };

  v1.get('/barrier-free', async (c) => {
    const { limit, offset } = paging(c);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (cond: string, val: unknown) => { params.push(val); where.push(cond.replace('?', `$${params.length}`)); };

    const type = c.req.query('type');        if (type) add('contenttypeid = ?', type);
    const region = c.req.query('region');    if (region) add('ldong_regn_cd = ?', region);
    const sigungu = c.req.query('sigungu');  if (sigungu) add('ldong_signgu_cd = ?', sigungu);
    const q = c.req.query('q');              if (q) add('title ilike ?', `%${q}%`);
    if (c.req.query('hasImage') === 'true') where.push('has_image');
    if (c.req.query('hasAccess') === 'true') where.push('has_access');

    // 접근성 그룹 필터(015 의 4개 플래그). `access=wheelchair,infant` 처럼 콤마로 준다.
    //  **AND 다** — 휠체어도 필요하고 유아 동반도 하는 사람에게 둘 중 하나만 되는 곳은
    //  갈 수 있는 곳이 아니다. OR 로 두면 휠체어(9,270곳)가 결과를 삼켜 필터가 무의미해진다.
    //
    //  ⚠️ 모르는 이름은 **조용히 무시한다**(400 이 아니다). 앱이 서버보다 먼저 항목을 늘릴 수
    //     있는데, 그때 400 을 주면 홈 화면 전체가 빈다. 필터가 하나 덜 걸리는 편이 낫다.
    //  ⚠️ 데이터가 얇은 그룹이 있다. 청각은 전국 107곳뿐이라(관광지 27·맛집 22·숙소 23·축제 0)
    //     이 필터를 걸면 목록이 빠르게 바닥난다. 채워 넣지 않는다 — 없는 것을 있는 것처럼
    //     보여 주면 무장애 앱에서는 그게 가장 나쁜 거짓말이다.
    const accessGroups = (c.req.query('access') ?? '')
      .split(',').map((v) => v.trim()).filter((name) => ACCESS_GROUP_COLUMNS[name]);
    for (const name of accessGroups) where.push(ACCESS_GROUP_COLUMNS[name]!);

    // 정렬. 구 기본값(has_image desc, has_access desc, contentid)은 앱이 hasImage/hasAccess 를
    // 이미 필터로 걸고 부르기 때문에 앞의 두 키가 결과 안에서 상수가 되어, 사실상 contentid 순
    // 고정이었다 — "추천"이 언제나 같은 6곳을 내주던 원인이다. 기본을 access 로 바꾼다.
    //  어느 정렬이든 마지막 키를 contentid 로 고정해야 offset 페이지네이션이 어긋나지 않는다.
    const sort = c.req.query('sort') ?? 'access';
    const orderParams = [...params];
    let orderBy: string;
    switch (sort) {
      case 'id':     // 구 동작 복원용
        orderBy = 'contentid';
        break;
      case 'random': // seed 를 주면 매 요청 같은 순서 — 페이지를 넘겨도 목록이 흔들리지 않는다
        orderParams.push(c.req.query('seed') ?? '0');
        orderBy = `md5(contentid || $${orderParams.length}), contentid`;
        break;
      default:       // 'access'
        // 사진 없는 장소는 **감점**으로 뒤로 민다. 걸러내지 않는 이유: 2026-08-16 측정 결과
        //  사진 유무로 접근성 정보량이 갈리지 않는다(무사진 평균 4.0 / 유사진 4.4, 중앙값 둘 다 4,
        //  최대 둘 다 18). 즉 사진이 없다는 건 정보가 부실하다는 뜻이 아니라 관광공사가 사진을
        //  안 올렸다는 뜻뿐이고, 무장애 여행 앱에서 그걸로 5곳 중 1곳(2,045/10,262)을 지울 이유가 없다.
        //  ⚠️ 점수가 4 언저리에 몰려 있어 감점을 크게 주면 사실상 필터와 같아진다. 3이면
        //  평범한 무사진 장소(4→1)는 뒤로 가지만 정보가 아주 풍부한 곳(18→15)은 앞에 남는다.
        {
          // 사진 없는 장소는 **감점**으로 뒤로 민다(걸러내지는 않는다, 위 주석 참고).
          const overall = `(${ACCESS_SCORE} - 3 * (not coalesce(has_image, false))::int) desc`;
          // 조건을 걸었으면 **그 축을 얼마나 갖췄는지**가 먼저다. 그러지 않으면 필터를 걸어도
          //  첫 페이지가 그대로라 사용자에게는 아무 일도 안 일어난 것으로 보인다.
          const matched = accessGroups.map((name) => ACCESS_GROUP_SCORES[name]!);
          // 같은 충실도면 **사진 있는 곳이 먼저** 온다. 전체 점수의 -3 감점을 그대로 쓸 수 없다 —
          //  그룹 점수는 4~12점 척도라 -3 이면 사실상 필터가 되어, 사진이 없다는 이유로
          //  가장 잘 맞는 곳이 통째로 사라진다(무장애 정보량과 사진 유무는 무관하다는 측정이
          //  애초에 걸러내지 않기로 한 근거였다). 그래서 감점 대신 동점 처리로 둔다.
          orderBy = matched.length
            ? `(${matched.join(' + ')}) desc, has_image desc nulls last, ${overall}, contentid`
            : `${overall}, contentid`;
        }
    }

    const wsql = where.length ? `where ${where.join(' and ')}` : '';
    // count 에는 정렬용 파라미터를 넘기지 않는다(바인딩 개수가 어긋난다)
    const total = (await query<{ n: number }>(`select count(*)::int n from barrier_free ${wsql}`, params)).rows[0]!.n;
    const rows = (await query(
      `select ${BF_COLS} from barrier_free ${wsql} order by ${orderBy} limit ${limit} offset ${offset}`, orderParams,
    )).rows;
    return c.json({ total, limit, offset, count: rows.length, sort, items: rows });
  });

  // TourAPI 텍스트 정리: <br> → ' / ', 태그 제거, 엔티티·공백 정리
  const cleanIntroText = (v: string | null | undefined): string | null => {
    if (!v) return null;
    const t = v
      .replace(/<br\s*\/?>/gi, ' / ')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return t.length ? t : null;
  };

  // homepage 원문('<a href="...">...</a>')에서 URL만 추출
  const extractUrl = (v: string | null | undefined): string | null => {
    if (!v) return null;
    const url = (v.match(/href="([^"]+)"/i)?.[1] ?? v).trim();
    return /^https?:\/\//i.test(url) ? url : null;
  };

  // detailIntro2 원본(타입별 필드 상이) → 기본정보 공통 스키마
  const basicInfoFrom = (intro: Record<string, string> | null | undefined, contentTypeId: string | null) => {
    const g = (k: string) => cleanIntroText(intro?.[k]);
    switch (contentTypeId) {
      case '12': // 관광지
        return { usetime: g('usetime'), restdate: g('restdate'), parking: g('parking'), fee: null, infocenter: g('infocenter') };
      case '32': { // 숙박: 입실/퇴실을 운영시간 형태로
        const checkin = g('checkintime');
        const checkout = g('checkouttime');
        const inout = [checkin && `입실 ${checkin}`, checkout && `퇴실 ${checkout}`].filter(Boolean).join(' / ');
        return { usetime: inout || null, restdate: null, parking: g('parkinglodging'), fee: null, infocenter: g('infocenterlodging') };
      }
      case '39': // 음식점
        return { usetime: g('opentimefood'), restdate: g('restdatefood'), parking: g('parkingfood'), fee: null, infocenter: g('infocenterfood') };
      case '15': { // 축제·공연: 공연시간 없으면 행사기간으로 대체
        const period = [g('eventstartdate'), g('eventenddate')].filter(Boolean).join(' ~ ');
        return { usetime: g('playtime') ?? (period || null), restdate: null, parking: null, fee: g('usetimefestival'), infocenter: g('sponsor1tel') };
      }
      default:
        return { usetime: null, restdate: null, parking: null, fee: null, infocenter: null };
    }
  };

  // 장소 상세 — 무장애 28속성 + kor_detail(개요·홈페이지·전화·기본정보) enrich
  v1.get('/barrier-free/:contentId', async (c) => {
    const id = c.req.param('contentId');
    const rows = (await query(`select ${BF_COLS} from barrier_free where contentid = $1`, [id])).rows;
    if (rows.length === 0) return c.json({ error: 'not_found' }, 404);
    const base = rows[0]! as Record<string, unknown>;

    const detail = (await query<{
      overview: string | null; homepage: string | null; tel: string | null;
      intro_raw: Record<string, string> | null;
    }>('select overview, homepage, tel, intro_raw from kor_detail where content_id = $1', [id])).rows[0];

    const info = basicInfoFrom(detail?.intro_raw, base.contenttypeid as string | null);
    return c.json({
      ...base,
      overview: detail?.overview?.trim() || null,
      homepage: extractUrl(detail?.homepage),
      tel: cleanIntroText(detail?.tel) ?? info.infocenter,
      basicInfo: { usetime: info.usetime, restdate: info.restdate, parking: info.parking, fee: info.fee },
    });
  });

  // 함께 가볼만한 곳 — 018 이 미리 계산해 둔 연관 장소. 조회 시점에 357만 행을 매칭하면 느리다.
  //  추천 대상은 전부 barrier_free 안에 있어서 카드를 누르면 위 상세 라우트로 이어진다.
  //  source(rlte/nearby/...)를 그대로 내려보내 품질 편차를 클라이언트에서도 계량할 수 있게 한다.
  v1.get('/barrier-free/:contentId/related', async (c) => {
    const id = c.req.param('contentId');
    // 캐러셀은 10장이면 충분하다. paging()의 기본 20 대신 10을 쓰되 상한은 그대로 100.
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 10) || 10));

    const rows = (await query<{
      contentid: string; title: string | null; addr1: string | null;
      firstimage: string | null; contenttypeid: string | null;
      has_access: boolean | null; access_wheelchair: boolean | null; access_visual: boolean | null;
      access_hearing: boolean | null; access_infant: boolean | null; access_elderly: boolean | null;
      rank: number; source: string;
    }>(`select b.contentid, b.title, b.addr1, b.firstimage, b.contenttypeid,
               b.has_access, b.access_wheelchair, b.access_visual, b.access_hearing, b.access_infant,
               b.access_elderly,
               r.rank, r.source
          from related_places r
          join barrier_free b on b.contentid = r.related_content_id
         where r.content_id = $1
         order by r.rank
         limit $2`, [id, limit])).rows;

    return c.json({
      contentId: id,
      limit,
      count: rows.length,
      items: rows.map((r) => ({
        contentId: r.contentid,
        title: r.title,
        // 카드의 "경북 경주시" 자리. 원본 주소도 함께 내려 클라이언트가 고를 수 있게 한다.
        region: shortRegion(r.addr1),
        addr1: r.addr1,
        imageURL: r.firstimage || null,
        category: r.contenttypeid ? CATEGORY_LABELS[r.contenttypeid] ?? null : null,
        hasAccess: r.has_access,
        access: {
          wheelchair: r.access_wheelchair,
          visual: r.access_visual,
          hearing: r.access_hearing,
          infant: r.access_infant,
          // 관광공사 5번째 유형(037). 휠체어 대여·이동보조기기·승강기·주차 중 하나라도 있으면 켠다.
          elderly: r.access_elderly,
        },
        rank: r.rank,
        source: r.source,
      })),
    });
  });

  // ILIKE 패턴 메타문자 이스케이프 (사용자 입력 검색어용)
  const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');

  // contenttypeid → 카테고리 라벨 (TourAPI 관광타입)
  const CATEGORY_LABELS: Record<string, string> = {
    '12': '관광지', '14': '문화시설', '15': '축제공연행사', '25': '여행코스',
    '28': '레포츠', '32': '숙박', '38': '쇼핑', '39': '음식점',
  };

  // 시도명 축약 — addr1 첫 토큰용
  const SIDO_SHORT: Record<string, string> = {
    '서울특별시': '서울', '부산광역시': '부산', '대구광역시': '대구', '인천광역시': '인천',
    '광주광역시': '광주', '대전광역시': '대전', '울산광역시': '울산', '세종특별자치시': '세종',
    '경기도': '경기', '강원특별자치도': '강원', '강원도': '강원',
    '충청북도': '충북', '충청남도': '충남',
    '전북특별자치도': '전북', '전라북도': '전북', '전라남도': '전남',
    '경상북도': '경북', '경상남도': '경남', '제주특별자치도': '제주', '제주도': '제주',
  };

  // addr1("서울특별시 종로구 사직로 161") → 축약 지역("서울 종로구")
  const shortRegion = (addr1: string | null): string | null => {
    if (!addr1) return null;
    const [sido, sigungu] = addr1.trim().split(/\s+/);
    if (!sido) return null;
    return [SIDO_SHORT[sido] ?? sido, sigungu].filter(Boolean).join(' ');
  };

  // 통합 검색 — 검색 페이지(iOS)용 (#3). barrier_free 대상, title·addr1 매칭 + 관련성 정렬
  v1.get('/search', async (c) => {
    const q = c.req.query('q')?.trim() ?? '';
    if (!q) return c.json({ error: 'missing_q' }, 400);
    if (q.length > 100) return c.json({ error: 'q_too_long' }, 400);
    const { limit, offset } = paging(c);
    const pattern = escapeLike(q); // $1 — ILIKE용, $2 는 정확 일치용 원문

    const wsql = `where title ilike '%' || $1 || '%' or addr1 ilike '%' || $1 || '%'`;
    const total = (await query<{ n: number }>(
      `select count(*)::int n from barrier_free ${wsql}`, [pattern],
    )).rows[0]!.n;
    // mapx/mapy 를 함께 내보낸다 — 목록(`BF_COLS`)·상세는 이미 주는데 검색만 자기 select 를
    //  따로 써서 빠져 있었다. 이게 없으면 검색으로 담은 장소는 좌표가 없어 플랜 지도에 핀이
    //  안 찍히고 구간 거리도 못 낸다(클라이언트가 상세를 한 번 더 부르는 수밖에 없었다).
    const rows = (await query<{
      contentid: string; title: string | null; contenttypeid: string | null;
      addr1: string | null; firstimage: string | null;
      mapx: number | null; mapy: number | null;
      access_wheelchair: boolean; access_visual: boolean; access_hearing: boolean;
      access_infant: boolean; access_elderly: boolean;
    }>(
      `select contentid, title, contenttypeid, addr1, firstimage, mapx, mapy,
              access_wheelchair, access_visual, access_hearing, access_infant, access_elderly
         from barrier_free ${wsql}
        order by case
            when lower(title) = lower($2)     then 0
            when title ilike $1 || '%'        then 1
            when title ilike '%' || $1 || '%' then 2
            else 3
          end, has_image desc, has_access desc, char_length(title), title, contentid
        limit ${limit} offset ${offset}`, [pattern, q],
    )).rows;

    const items = rows.map((r) => ({
      contentid: r.contentid,
      title: r.title,
      contenttypeid: r.contenttypeid,
      category: (r.contenttypeid && CATEGORY_LABELS[r.contenttypeid]) || null,
      region: shortRegion(r.addr1),
      firstimage: r.firstimage || null,
      // 목록·상세와 같은 표기 — mapx=경도, mapy=위도. 원본에 좌표가 없는 장소는 null 이다.
      mapx: r.mapx,
      mapy: r.mapy,
      access: {
        wheelchair: r.access_wheelchair, visual: r.access_visual,
        hearing: r.access_hearing, infant: r.access_infant,
        elderly: r.access_elderly,
      },
    }));
    return c.json({ total, limit, offset, count: items.length, items });
  });

  // ── 여행자 리뷰 ─────────────────────────────────────────────────────────────

  // 작성자 레벨은 저장하지 않고 리뷰 수에서 파생한다.
  //  근거: 레벨은 "얼마나 기여했나"의 표시일 뿐이라 리뷰가 지워지면 함께 내려가야 일관적이다.
  //  저장해두면 리뷰 수와 어긋나는 순간(삭제·기기 병합·계정 이관)이 반드시 생긴다.
  //  구간 임계값은 대략 2배씩 키워(1·3·6·10·20·50·100) 초반은 빠르게, 뒤로 갈수록 어렵게 —
  //  흔한 기여도 레벨 곡선. 최대 8 (0건=1, 1~2건=2, 3~5건=3 … 100건+=8).
  //  ⚠️ 피그마 시안의 "Level 7 / 3개의 리뷰" 조합은 어떤 단조 매핑으로도 재현되지 않는
  //     더미 값이다. 시안 숫자를 그대로 맞추려 하지 말 것.
  const LEVEL_THRESHOLDS = [1, 3, 6, 10, 20, 50, 100];
  const levelFor = (reviewCount: number): number =>
    1 + LEVEL_THRESHOLDS.filter((t) => reviewCount >= t).length;

  // 리뷰 목록/단건 공통 select.
  //  ⚠️ authors.device_id 는 사실상 신원 토큰이므로 절대 select 하지 않는다.
  //  author_review_count 는 작성자별 총 리뷰 수(레벨 파생용). author_id 가 없으면 0.
  // 보는 사람 파라미터 번호를 받는다(게시글 postSelect 와 같은 방식). count 쿼리는 이 SELECT 를
  //  쓰지 않아 viewer 가 필요 없으므로, 번호를 고정($1)하지 않고 호출부가 정하게 한다.
  const reviewSelect = (viewer: number) => `
    select r.id, r.content_id as "contentId", r.location_nm as location,
           r.author_nm as author, r.body, r.rating,
           r.like_count as "likeCount", r.comment_count as "commentCount",
           -- 보는 사람이 좋아요했는지. 비로그인이면 그 파라미터가 null 이라 exists 가 늘 false 다
           --  (장소상세에서 하트가 눌린 상태로 그려지려면 이게 필요하다).
           exists (select 1 from review_likes rl
                    where rl.review_id = r.id and rl.author_id = $${viewer}) as "likedByMe",
           r.is_accessibility_verified as "isAccessibilityVerified",
           r.image_urls as "imageURLs",
           r.would_revisit as "wouldRevisit",
           to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "createdAt",
           a.nickname as author_nickname,
           (select count(*)::int from reviews r2 where r2.author_id = r.author_id) as author_review_count,
           -- 후기 뱃지용 태그(019). 시안은 뱃지에 짧은 이름을 쓰지만 긴 이름도 함께 보내
           -- 클라이언트가 상황에 맞게 고르게 한다. 태그가 없으면 빈 배열.
           (select coalesce(json_agg(json_build_object(
                     'code', d.code, 'label', d.label,
                     'shortLabel', d.short_label, 'icon', d.icon
                   ) order by d.sort_order), '[]'::json)
              from review_tags rt join review_tag_defs d on d.code = rt.tag_code
             where rt.review_id = r.id) as tags
      from reviews r
      left join authors a on a.id = r.author_id`;

  type ReviewRow = Record<string, unknown> & {
    author: string;
    author_nickname: string | null;
    author_review_count: number | null;
  };

  // 기존 응답 필드는 그대로 두고(iOS 라이브 사용 중) 작성자 프로필만 authorInfo 로 덧붙인다.
  //  · author  : 레거시 문자열(닉네임). 제거하면 iOS ReviewDTO 디코딩이 깨진다.
  //  · authorInfo: {nickname, reviewCount, level} — 시안의 "닉네임 / Level N / N개의 리뷰"용.
  const shapeReview = (row: ReviewRow) => {
    const { author_nickname: nickname, author_review_count: count, ...rest } = row;
    const reviewCount = count ?? 0;
    return {
      ...rest,
      authorInfo: { nickname: nickname ?? row.author, reviewCount, level: levelFor(reviewCount) },
    };
  };

  // 리뷰 목록 — iOS TravelReview 필드명으로 매핑. contentId 로 장소별 필터.
  //  정렬: recommended(기본, 좋아요+댓글) / likes(좋아요만 — 시안의 "좋아요 순") / latest.
  //   ⚠️ likes 와 recommended 를 같은 것으로 취급하지 말 것. 시안이 요구하는 건 좋아요 순이고
  //      recommended 는 댓글까지 더한 값이라 순서가 다르게 나온다.
  const REVIEW_ORDERS: Record<string, string> = {
    latest: 'r.created_at desc',
    likes: 'r.like_count desc, r.created_at desc',
    recommended: '(r.like_count + r.comment_count) desc, r.created_at desc',
  };

  v1.get('/reviews', async (c) => {
    const { limit, offset } = paging(c);
    const sort = c.req.query('sort') ?? 'recommended';
    const order = REVIEW_ORDERS[sort] ?? REVIEW_ORDERS.recommended;
    const where: string[] = [];
    // 필터 파라미터는 $1 부터(count 와 SELECT 가 공유). 보는 사람은 **맨 뒤**에 붙여
    //  SELECT 에만 쓴다 — count 는 review_likes 를 보지 않아 viewer 가 필요 없다.
    const filters: unknown[] = [];
    const contentId = c.req.query('contentId');
    if (contentId) { filters.push(contentId); where.push(`r.content_id = $${filters.length}`); }
    // 시안의 "사진/영상 후기만 보기". image_urls 가 null 인 행도 있어 coalesce 로 감싼다.
    if (c.req.query('hasImage') === 'true') where.push('coalesce(array_length(r.image_urls, 1), 0) > 0');
    const wsql = where.length ? `where ${where.join(' and ')}` : '';

    // count: 필터만.
    const total = (await query<{ n: number }>(
      `select count(*)::int n from reviews r ${wsql}`, filters)).rows[0]!.n;
    // SELECT: 필터 + 맨 뒤 viewer.
    const params = [...filters, authorOf(c)];
    const rows = (await query<ReviewRow>(
      `${reviewSelect(params.length)} ${wsql} order by ${order} limit ${limit} offset ${offset}`, params,
    )).rows;
    return c.json({ total, limit, offset, sort, count: rows.length, items: rows.map(shapeReview) });
  });

  // 후기 태그 카탈로그(019) — 작성 화면의 "어떤 점이 좋았나요?" 칩 목록.
  //  DB 가 원본이라 문구·순서·아이콘이 바뀌어도 앱 재배포가 필요 없다.
  //  icon 이 null 인 태그는 아직 브랜드 에셋이 없다는 뜻 — 클라이언트는 텍스트만 렌더한다.
  v1.get('/review-tags', async (c) => {
    const rows = (await query(
      `select code, label, short_label as "shortLabel", icon
         from review_tag_defs order by sort_order, code`,
    )).rows;
    return c.json({ count: rows.length, items: rows });
  });

  // 장소 단위 전체 평점 — 시안 "★ 4.3 · 후기 235"
  //  ⚠️ rating 이 null 인 리뷰(별점 없는 레거시·텍스트 전용)는 평균에서 제외된다.
  //     그 사실이 응답에 드러나도록 평균의 모집단 크기를 ratedCount 로 함께 돌려준다.
  //     reviewCount = 전체 후기 수 / ratedCount = 그중 별점이 있는 수 (둘이 다를 수 있음).
  //     별점이 하나도 없으면 avgRating 은 null.
  v1.get('/reviews/summary', async (c) => {
    const contentId = c.req.query('contentId')?.trim();
    if (!contentId) return c.json({ error: 'missing_contentId', message: 'contentId 는 필수입니다.' }, 400);
    const row = (await query<{ review_count: number; rated_count: number; avg_rating: number | null }>(
      `select count(*)::int          as review_count,
              count(rating)::int     as rated_count,
              round(avg(rating)::numeric, 1)::float8 as avg_rating
         from reviews where content_id = $1`, [contentId],
    )).rows[0]!;
    // 태그 집계 막대 — 시안의 "♿ 무장애 친화적이에요 … 21명".
    //  ⚠️ 시안 주석의 "20명 이상만 노출" 임계값은 적용하지 않는다(개발 단계에서 20명을
    //     채울 수 없어 막대가 전부 사라진다). 노출 기준은 클라이언트가 정하게 두고
    //     서버는 전부 내려보낸다. 정렬은 시안처럼 인원 많은 순.
    const tags = (await query(
      `select d.code, d.label, d.short_label as "shortLabel", d.icon, count(*)::int as count
         from review_tags rt
         join reviews r        on r.id = rt.review_id
         join review_tag_defs d on d.code = rt.tag_code
        where r.content_id = $1
        group by d.code, d.label, d.short_label, d.icon, d.sort_order
        order by count desc, d.sort_order`, [contentId],
    )).rows;
    return c.json({
      contentId,
      avgRating: row.avg_rating,
      reviewCount: row.review_count,
      ratedCount: row.rated_count,
      tags,
    });
  });

  // 후기 사진 업로드 — 작성 완료 전에 올려서 앱이 썸네일을 미리 보여줄 수 있게 한다.
  //  반환된 URL 을 POST /v1/reviews 의 imageURLs 에 그대로 넣으면 된다.
  //
  //  ⚠️ 서버는 리사이즈하지 않는다. iOS 가 장변 1280px·JPEG q0.8 로 줄여서 올린다 —
  //     sharp 같은 네이티브 의존성을 Docker 에 넣지 않아도 되고, 모바일 업로드도 빨라지며,
  //     재인코딩 과정에서 GPS 등 EXIF 가 사라지는 프라이버시 이점까지 따라온다.
  v1.post('/reviews/images', async (c) => {
    // 볼륨이 안 붙은 채 배포되면 컨테이너 임시 파일시스템에 쓰게 되고, 재배포 때 사진이
    // 조용히 사라진다. 그 상태를 숨기지 말고 503 으로 드러낸다.
    const probeDir = join(config.api.uploadDir, 'reviews');
    try {
      await mkdir(probeDir, { recursive: true });
    } catch {
      return c.json({
        error: 'storage_unavailable',
        message: `업로드 저장소(${config.api.uploadDir})에 쓸 수 없습니다. 볼륨 마운트를 확인하세요.`,
      }, 503);
    }

    const contentLength = Number(c.req.header('content-length') ?? 0);
    if (contentLength > config.api.maxUploadBytes) {
      return c.json({
        error: 'payload_too_large',
        message: `요청 전체는 ${Math.round(config.api.maxUploadBytes / 1024 / 1024)}MB 이하여야 합니다.`,
      }, 413);
    }

    let form: Record<string, unknown>;
    try {
      form = await c.req.parseBody({ all: true });
    } catch {
      return c.json({ error: 'invalid_multipart', message: 'multipart/form-data 로 보내주세요.' }, 400);
    }

    const raw = form.files ?? form.file;
    const files = (Array.isArray(raw) ? raw : [raw]).filter((f): f is File => f instanceof File);
    if (files.length === 0) {
      return c.json({ error: 'missing_files', message: "파일을 'files' 필드로 보내주세요." }, 400);
    }
    if (files.length > MAX_IMAGES) {
      return c.json({ error: 'too_many_files', message: `사진은 최대 ${MAX_IMAGES}장까지 가능합니다.` }, 400);
    }

    const origin = `${c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol.replace(':', '')}://${c.req.header('host')}`;
    const items: { url: string; bytes: number; type: string }[] = [];

    for (const file of files) {
      // 디스크에 쓰기 전에 크기부터 본다.
      if (file.size > config.api.maxImageBytes) {
        return c.json({
          error: 'image_too_large',
          message: `사진 한 장은 ${Math.round(config.api.maxImageBytes / 1024 / 1024)}MB 이하여야 합니다. 앱이 올리기 전에 줄여야 합니다.`,
        }, 400);
      }
      const buf = Buffer.from(await file.arrayBuffer());
      const kind = sniffImage(buf);
      if (!kind) {
        return c.json({
          error: 'invalid_image',
          message: '이미지 파일이 아닙니다(JPEG·PNG·HEIC 만 지원).',
        }, 400);
      }

      const name = `${createHash('sha256').update(buf).digest('hex')}.${kind.ext}`;
      const path = imagePathFor(name);
      await mkdir(dirname(path), { recursive: true });
      // 같은 내용이면 이미 있는 파일을 덮어쓸 뿐이라 중복 저장이 생기지 않는다.
      await writeFile(path, buf);
      items.push({ url: `${origin}/images/reviews/${name}`, bytes: buf.length, type: kind.mime });
    }

    return c.json({ count: items.length, items }, 201);
  });

  // 리뷰 작성 — 유일한 쓰기 엔드포인트. 인증·레이트리밋은 /v1/* 공통(Bearer API 키) 그대로.
  //  작성자는 **세션의 계정**이다(030). 예전에는 deviceId + 닉네임으로 식별했는데,
  //  그 방식은 "deviceId 를 아는 사람이 그 사람"이라 남의 글을 대신 쓸 수 있었다.
  //  authorNm 은 이제 선택이다 — 보내면 계정 닉네임을 갱신하고, 생략하면 기존 값을 쓴다.
  const MAX_BODY_LEN = 2000;
  const MAX_IMAGES = 5;      // 앱 리뷰 카드가 1~5장 레이아웃 기준(014 참고)
  const MAX_NICKNAME_LEN = 40;
  const MAX_TAGS = 8;        // 카탈로그 전체 개수. 전부 고르는 것까지는 허용한다

  v1.post('/reviews', async (c) => {
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json', message: 'JSON 본문을 파싱할 수 없습니다.' }, 400);
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return c.json({ error: 'invalid_body', message: 'JSON 객체를 보내주세요.' }, 400);
    }
    const p = payload as Record<string, unknown>;
    const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

    const locationNm = str(p.locationNm);
    const bodyText = str(p.body);
    const authorNm = str(p.authorNm);
    const contentId = str(p.contentId) || null;
    const rating = p.rating;

    const gate = requireAuth(c);
    if (gate instanceof Response) return gate;
    if (!locationNm) return c.json({ error: 'missing_locationNm', message: 'locationNm(장소명)은 필수입니다.' }, 400);
    if (locationNm.length > 200) return c.json({ error: 'invalid_locationNm', message: 'locationNm 은 200자 이하여야 합니다.' }, 400);
    if (!bodyText) return c.json({ error: 'missing_body', message: 'body(후기 본문)는 비어 있을 수 없습니다.' }, 400);
    if (bodyText.length > MAX_BODY_LEN) return c.json({ error: 'invalid_body', message: `body 는 ${MAX_BODY_LEN}자 이하여야 합니다.` }, 400);
    if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) {
      return c.json({ error: 'invalid_rating', message: 'rating 은 1~5 사이의 정수여야 합니다.' }, 400);
    }
    if (contentId && contentId.length > 64) return c.json({ error: 'invalid_contentId', message: 'contentId 는 64자 이하여야 합니다.' }, 400);
    if (authorNm.length > MAX_NICKNAME_LEN) {
      return c.json({ error: 'invalid_authorNm', message: `authorNm 은 ${MAX_NICKNAME_LEN}자 이하여야 합니다.` }, 400);
    }

    // 사진 URL — 이번 범위는 "이미 업로드된 URL 받기"까지. 업로드 자체는 별도 작업.
    let imageURLs: string[] = [];
    const rawImages = p.imageURLs;
    if (rawImages != null) {
      if (!Array.isArray(rawImages) || rawImages.some((v) => typeof v !== 'string')) {
        return c.json({ error: 'invalid_imageURLs', message: 'imageURLs 는 문자열 배열이어야 합니다.' }, 400);
      }
      imageURLs = rawImages.map((v) => (v as string).trim()).filter(Boolean);
      if (imageURLs.length > MAX_IMAGES) {
        return c.json({ error: 'invalid_imageURLs', message: `사진은 최대 ${MAX_IMAGES}장까지 가능합니다.` }, 400);
      }
      if (!imageURLs.every((u) => /^https?:\/\//i.test(u))) {
        return c.json({ error: 'invalid_imageURLs', message: 'imageURLs 는 http(s) URL 이어야 합니다.' }, 400);
      }
    }

    // 태그(019) — 카탈로그에 있는 code 만 받는다. 모르는 code 를 조용히 버리면 사용자가
    //  고른 태그가 왜 사라졌는지 알 수 없으므로 400 으로 알린다. 중복은 알아서 제거한다.
    let tagCodes: string[] = [];
    const rawTags = p.tags;
    if (rawTags != null) {
      if (!Array.isArray(rawTags) || rawTags.some((v) => typeof v !== 'string')) {
        return c.json({ error: 'invalid_tags', message: 'tags 는 문자열 배열이어야 합니다.' }, 400);
      }
      tagCodes = [...new Set(rawTags.map((v) => (v as string).trim()).filter(Boolean))];
      if (tagCodes.length > MAX_TAGS) {
        return c.json({ error: 'invalid_tags', message: `태그는 최대 ${MAX_TAGS}개까지 가능합니다.` }, 400);
      }
      if (tagCodes.length) {
        const knownCodes = (await query<{ code: string }>(
          'select code from review_tag_defs where code = any($1::text[])', [tagCodes],
        )).rows.map((r) => r.code);
        const unknownCodes = tagCodes.filter((t) => !knownCodes.includes(t));
        if (unknownCodes.length) {
          return c.json({
            error: 'invalid_tags',
            message: `알 수 없는 태그입니다: ${unknownCodes.join(', ')}. GET /v1/review-tags 로 목록을 확인하세요.`,
          }, 400);
        }
      }
    }

    // 재방문 의향 — 유저가 직접 고른 값만 저장한다. 안 보내면 null(미응답)이고
    //  서버가 별점을 보고 추측하지 않는다. 별점과 독립인 축이다(019 주석 참고).
    let wouldRevisit: boolean | null = null;
    if (p.wouldRevisit != null) {
      if (typeof p.wouldRevisit !== 'boolean') {
        return c.json({ error: 'invalid_wouldRevisit', message: 'wouldRevisit 은 true 또는 false 여야 합니다.' }, 400);
      }
      wouldRevisit = p.wouldRevisit;
    }

    // 닉네임을 요구하지 않는다 — 로그인 계정에는 가입 시 정해진 닉네임이 항상 있다.
    //  authorNm 을 보내면 그 값으로 갱신하고, 생략하면 기존 값을 그대로 쓴다.

    const newId = await withTransaction(async (client) => {
      // 작성자는 세션의 계정이다. 익명 계정을 만드는 경로는 없다(030).
      //  닉네임을 보냈으면 갱신하고, 생략하면 기존 값을 그대로 쓴다.
      const author = (await client.query<{ id: number; nickname: string }>(
        `update authors set nickname = coalesce(nullif($2, ''), nickname)
          where id = $1 returning id, nickname`, [gate.authorId, authorNm],
      )).rows[0];
      // 세션이 가리키는 계정이 그 사이 지워진 경우에만 없다.
      if (!author) throw new Error('author_missing');

      // author_nm 은 레거시 표시용 컬럼 — 정규화된 닉네임과 어긋나지 않게 같은 값을 넣는다.
      const inserted = (await client.query<{ id: number }>(
        `insert into reviews (content_id, location_nm, author_nm, author_id, body, rating, image_urls, would_revisit)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [contentId, locationNm, author.nickname, author.id, bodyText, rating, imageURLs, wouldRevisit],
      )).rows[0]!;

      // 태그는 같은 트랜잭션에서 넣는다 — 후기만 남고 태그가 빠지는 상태를 만들지 않는다.
      if (tagCodes.length) {
        await client.query(
          'insert into review_tags (review_id, tag_code) select $1, unnest($2::text[])',
          [inserted.id, tagCodes],
        );
      }
      return inserted.id;
    });

    const row = (await query<ReviewRow>(
      `${reviewSelect(2)} where r.id = $1`, [newId, gate.authorId])).rows[0]!;
    return c.json(shapeReview(row), 201);
  });

  // ── 리뷰 댓글(020) ──────────────────────────────────────────────────────────
  //  작성자 식별은 리뷰와 같다(기기 UUID + 닉네임 → authors 대리키). device_id 는 내보내지 않는다.
  const MAX_COMMENT_LEN = 1000;

  const COMMENT_SELECT = `
    select c.id, c.body,
           to_char(c.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "createdAt",
           a.nickname as author,
           (select count(*)::int from reviews r2 where r2.author_id = c.author_id) as author_review_count
      from review_comments c
      join authors a on a.id = c.author_id`;

  type CommentRow = Record<string, unknown> & { author: string; author_review_count: number | null };

  const shapeComment = (row: CommentRow) => {
    const { author_review_count: count, ...rest } = row;
    const reviewCount = count ?? 0;
    return {
      ...rest,
      authorInfo: { nickname: row.author, reviewCount, level: levelFor(reviewCount) },
    };
  };

  /** 경로의 reviewId 를 정수로. 형식이 틀리면 null (404 로 응답한다). */
  const parseReviewId = (raw: string): number | null => {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  };

  // 댓글 목록 — 대화 순서(오래된 순). 리뷰가 없으면 404.
  v1.get('/reviews/:reviewId/comments', async (c) => {
    const reviewId = parseReviewId(c.req.param('reviewId'));
    if (reviewId == null) return c.json({ error: 'not_found', message: '리뷰를 찾을 수 없습니다.' }, 404);
    const { limit, offset } = paging(c);

    const exists = (await query<{ id: number }>('select id from reviews where id = $1', [reviewId])).rows[0];
    if (!exists) return c.json({ error: 'not_found', message: '리뷰를 찾을 수 없습니다.' }, 404);

    const total = (await query<{ n: number }>(
      'select count(*)::int n from review_comments where review_id = $1', [reviewId],
    )).rows[0]!.n;
    const rows = (await query<CommentRow>(
      `${COMMENT_SELECT} where c.review_id = $1 order by c.created_at, c.id limit ${limit} offset ${offset}`,
      [reviewId],
    )).rows;
    return c.json({ reviewId, total, limit, offset, count: rows.length, items: rows.map(shapeComment) });
  });

  // 댓글 작성
  v1.post('/reviews/:reviewId/comments', async (c) => {
    const reviewId = parseReviewId(c.req.param('reviewId'));
    if (reviewId == null) return c.json({ error: 'not_found', message: '리뷰를 찾을 수 없습니다.' }, 404);

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json', message: 'JSON 본문을 파싱할 수 없습니다.' }, 400);
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return c.json({ error: 'invalid_body', message: 'JSON 객체를 보내주세요.' }, 400);
    }
    const p = payload as Record<string, unknown>;
    const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

    const bodyText = str(p.body);
    const authorNm = str(p.authorNm);

    const gate = requireAuth(c);
    if (gate instanceof Response) return gate;
    if (!bodyText) return c.json({ error: 'missing_body', message: '댓글 내용은 비어 있을 수 없습니다.' }, 400);
    if (bodyText.length > MAX_COMMENT_LEN) {
      return c.json({ error: 'invalid_body', message: `댓글은 ${MAX_COMMENT_LEN}자 이하여야 합니다.` }, 400);
    }
    if (authorNm.length > MAX_NICKNAME_LEN) {
      return c.json({ error: 'invalid_authorNm', message: `authorNm 은 ${MAX_NICKNAME_LEN}자 이하여야 합니다.` }, 400);
    }

    const review = (await query<{ id: number }>('select id from reviews where id = $1', [reviewId])).rows[0];
    if (!review) return c.json({ error: 'not_found', message: '리뷰를 찾을 수 없습니다.' }, 404);

    // 리뷰 작성과 같은 규칙 — 처음 쓰는 기기는 닉네임이 필수다.

    const newId = await withTransaction(async (client) => {
      const author = (await client.query<{ id: number }>(
        `update authors set nickname = coalesce(nullif($2, ''), nickname)
          where id = $1 returning id`, [gate.authorId, authorNm],
      )).rows[0];
      if (!author) throw new Error('author_missing');

      const inserted = (await client.query<{ id: number }>(
        'insert into review_comments (review_id, author_id, body) values ($1, $2, $3) returning id',
        [reviewId, author.id, bodyText],
      )).rows[0]!;

      // 목록 응답과 '추천순' 정렬이 읽는 카운터를 같은 트랜잭션에서 올린다 —
      // 댓글은 늘었는데 화면의 댓글 수만 그대로인 상태를 만들지 않는다.
      await client.query('update reviews set comment_count = comment_count + 1 where id = $1', [reviewId]);
      return inserted.id;
    });

    const row = (await query<CommentRow>(`${COMMENT_SELECT} where c.id = $1`, [newId])).rows[0]!;
    return c.json(shapeComment(row), 201);
  });

  // ── 플랜(021) ───────────────────────────────────────────────────────────────
  //  리뷰와 달리 **개인 데이터**다. 조회도 로그인한 소유자로 좁히고, 남의 플랜은 보이지 않는다.
  //  플랜 본문(days/items)은 통째로 교체한다 — 순서 바꾸기·장소 추가·메모가 한 번에 일어나는
  //  편집이라 부분 갱신 API 를 여러 개 두면 클라이언트가 순서를 맞추다 어긋난다.

  /**
   * 이 요청의 작성자. **세션이 유일한 신원이다.**
   *
   * 030 부터 쓰기와 개인 데이터 조회는 로그인해야 한다. 그래서 deviceId 폴백이 없다 —
   * 폴백이 있던 동안은 "deviceId 를 아는 사람이 그 사람이 되는" 상태였고, 그것이
   * 익명 계정 탈취의 근원이었다. 지금은 익명 계정 자체가 생기지 않는다.
   *
   * 그래서 이 파일은 deviceId 를 더 이상 읽지 않는다. 기기 기록은 로그인 시점에
   * author_devices 로 한 번 남고(accounts.signIn), 그 뒤로는 신원과 무관하다.
   */
  const authorOf = (c: Context<AppEnv>): number | null => c.get('authorId') ?? null

  /**
   * 로그인 필수 라우트의 관문. 세션이 없으면 401 을 돌려준다.
   *
   * 앱은 이 응답을 받으면 로그인 창을 띄운다 — 그래서 error 코드를 session_expired 와
   * 구분한다(저쪽은 "토큰이 낡았다", 이쪽은 "아직 로그인하지 않았다").
   */
  const requireAuth = (c: Context<AppEnv>): { authorId: number } | Response => {
    const authorId = authorOf(c)
    if (authorId == null) {
      return c.json({ error: 'login_required', message: '로그인이 필요합니다.' }, 401)
    }
    return { authorId }
  }

  const PLAN_SELECT = `
    select p.id, p.title,
           to_char(p.start_date, 'YYYY-MM-DD') as "startDate",
           to_char(p.end_date, 'YYYY-MM-DD')   as "endDate",
           p.region, p.party, p.cover_image_url as "coverImageURL",
           p.themes, p.budget, p.day_trip_only as "dayTripOnly",
           to_char(p.confirmed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "confirmedAt",
           to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "createdAt",
           to_char(p.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "updatedAt"
      from plans p`;

  /** 한 플랜의 days/items 를 한 번에 읽어 중첩 구조로 만든다(N+1 회피). */
  async function loadDays(planId: string) {
    const rows = (await query<Record<string, unknown>>(
      `select d.id as day_id, to_char(d.date, 'YYYY-MM-DD') as day_date, d.position as day_position,
              i.id as item_id, i.position as item_position, i.kind, i.memo_text,
              i.content_id, i.place_name, i.category_label, i.category, i.region,
              i.image_url, i.latitude, i.longitude
         from plan_days d
         left join plan_items i on i.day_id = d.id
        where d.plan_id = $1
        order by d.position, i.position`, [planId],
    )).rows;

    const days = new Map<string, { id: string; date: unknown; items: unknown[] }>();
    for (const r of rows) {
      const dayId = r.day_id as string;
      if (!days.has(dayId)) days.set(dayId, { id: dayId, date: r.day_date, items: [] });
      if (!r.item_id) continue; // 항목이 하나도 없는 날 (left join)
      days.get(dayId)!.items.push(
        r.kind === 'memo'
          ? { id: r.item_id, kind: 'memo', text: r.memo_text }
          : {
              id: r.item_id, kind: 'stop',
              place: {
                contentID: r.content_id, name: r.place_name,
                categoryLabel: r.category_label, category: r.category,
                region: r.region, imageURL: r.image_url,
                latitude: r.latitude, longitude: r.longitude,
              },
            },
      );
    }
    return [...days.values()];
  }

  /**
   * 목록 카드용 요약 — 날짜별 **장소 이름만**, 여러 플랜을 한 방에 읽는다(N+1 회피).
   *
   * 일정 탭 카드가 "DAY 1  황리단길 - 포석정 - 나정고운모래해변" 처럼 그날 동선을 한 줄로 보여 준다.
   * 그렇다고 목록 응답에 days 를 통째로 실으면 플랜이 늘수록 응답이 빠르게 커진다 —
   * 카드에 필요한 것은 이름뿐이라 좌표·카테고리·이미지는 뺀다.
   *
   * ⚠️ 항목이 없는 날도 `left join` 으로 남긴다. 빼 버리면 그 뒤 날들의 DAY 번호가 하나씩 당겨져
   *    상세 화면과 어긋난다(앱은 days 의 순서로 번호를 매긴다).
   * 메모만 있는 날은 `placeNames` 가 빈 배열이 된다 — 카드는 그 줄을 그리지 않지만 번호는 살아 있다.
   *
   * `fallbackImageUrl` 은 첫 장소의 사진이다. 카드가 풀블리드 사진인데 `coverImageURL` 을 채울
   * 화면이 아직 없어 사실상 늘 비어 있다. 사용자가 직접 고른 값이라는 뜻을 지키려고 그 필드를
   * 덮어쓰지 않고 따로 내려보낸다.
   */
  async function loadSummaries(planIds: string[]) {
    const empty = new Map<string, { daySummaries: unknown[]; fallbackImageUrl: string | null }>();
    if (!planIds.length) return empty;

    const rows = (await query<{
      plan_id: string; day_id: string; day_date: string;
      place_name: string | null; image_url: string | null;
    }>(
      `select d.plan_id, d.id as day_id, to_char(d.date, 'YYYY-MM-DD') as day_date,
              i.place_name, i.image_url
         from plan_days d
         left join plan_items i on i.day_id = d.id and i.kind = 'stop'
        where d.plan_id = any($1::uuid[])
        order by d.plan_id, d.position, i.position`, [planIds],
    )).rows;

    for (const r of rows) {
      if (!empty.has(r.plan_id)) empty.set(r.plan_id, { daySummaries: [], fallbackImageUrl: null });
      const entry = empty.get(r.plan_id)!;
      const days = entry.daySummaries as { id: string; date: string; placeNames: string[] }[];

      let day = days.find((d) => d.id === r.day_id);
      if (!day) { day = { id: r.day_id, date: r.day_date, placeNames: [] }; days.push(day); }

      if (r.place_name) day.placeNames.push(r.place_name);
      if (!entry.fallbackImageUrl && r.image_url) entry.fallbackImageUrl = r.image_url;
    }
    return empty;
  }

  // 내 플랜 목록 — 최근 여행부터.
  //  본문(days)은 싣지 않되, 카드가 그릴 만큼의 요약(`daySummaries`)은 함께 내려보낸다.
  v1.get('/plans', async (c) => {
    const gate = requireAuth(c);
    if (gate instanceof Response) return gate;

    const authorId: number | null = gate.authorId;
    if (authorId == null) return c.json({ count: 0, items: [] });

    const rows = (await query<Record<string, unknown>>(
      `${PLAN_SELECT} where p.author_id = $1 order by p.start_date desc, p.created_at desc`,
      [authorId],
    )).rows;

    const summaries = await loadSummaries(rows.map((r) => r.id as string));
    const items = rows.map((r) => ({
      ...r,
      daySummaries: summaries.get(r.id as string)?.daySummaries ?? [],
      fallbackImageUrl: summaries.get(r.id as string)?.fallbackImageUrl ?? null,
    }));
    return c.json({ count: items.length, items });
  });

  // 플랜 상세 — days/items 포함
  v1.get('/plans/:planId', async (c) => {
    const gate = requireAuth(c);
    if (gate instanceof Response) return gate;
    const authorId: number | null = gate.authorId;

    const plan = (await query<Record<string, unknown>>(
      `${PLAN_SELECT} where p.id = $1 and p.author_id = $2`,
      [c.req.param('planId'), authorId],
    )).rows[0];
    // 남의 플랜과 없는 플랜을 구분해 주지 않는다 — 존재 여부가 새어 나갈 이유가 없다.
    if (!plan) return c.json({ error: 'not_found', message: '플랜을 찾을 수 없습니다.' }, 404);

    return c.json({ ...plan, days: await loadDays(plan.id as string) });
  });

  // 새 플랜 플로우 4/6·5/6 의 선택지. 표시 문구를 앱에 하드코딩하지 않고 여기서 내려보낸다 —
  //  문구가 바뀔 때 앱 재배포 대신 서버 배포로 끝난다(후기 태그 카탈로그와 같은 이유).
  const PLAN_THEMES = [
    { code: 'camping', label: '차박·캠핑' },
    { code: 'waterpark', label: '워터파크' },
    { code: 'photo', label: 'SNS 사진' },
    { code: 'nature', label: '자연과 함께' },
    { code: 'indoor', label: '실내' },
    { code: 'heritage', label: '전통과 역사' },
    { code: 'scenery', label: '아름다운 풍경' },
    { code: 'shopping', label: '쇼핑하기' },
    { code: 'culture', label: '문화·예술' },
    { code: 'art', label: '미술' },
    { code: 'food', label: '먹방 투어' },
    { code: 'nightview', label: '야경이 예쁜 곳' },
  ] as const
  const PLAN_BUDGETS = [
    { code: 'low', label: '저예산', hint: '아끼고 싶어요' },
    { code: 'medium', label: '중예산', hint: '부담스럽지 않게 쓰고 싶어요' },
    { code: 'high', label: '고예산', hint: '여유 있게 즐길래요' },
  ] as const
  const THEME_CODES = new Set<string>(PLAN_THEMES.map((t) => t.code))
  const BUDGET_CODES = new Set<string>(PLAN_BUDGETS.map((b) => b.code))

  // 새 플랜 플로우가 그릴 선택지 목록. 인증만 필요하고 사용자별 값이 아니다.
  v1.get('/plan-options', (c) => c.json({ themes: PLAN_THEMES, budgets: PLAN_BUDGETS }))

  // ── AI 추천 코스 ────────────────────────────────────────────────────────────
  //  기획팀 명세("AI 추천 코스 로직") v1. 점수는 코드가 아니라 recommend_weights 에 있다.
  //
  //  ⚠️ 서버에서 계산하는 이유가 세 가지다 — 혼잡도·인기순위·후기태그가 전부 DB 에 있고,
  //     카카오 키를 앱에 넣을 수 없으며(v2 경로 안내), 가중치를 배포 없이 바꿔야 한다.
  //  ⚠️ 플랜을 **저장하지 않는다.** 추천은 제안일 뿐이고, 사용자가 고른 뒤 기존
  //     PUT /v1/plans/:planId 로 저장한다. 추천마다 플랜이 쌓이면 목록이 쓰레기로 찬다.
  v1.post('/plans/recommend', async (c) => {
    const gate = requireAuth(c)
    if (gate instanceof Response) return gate

    const p = await (async () => {
      try { return await c.req.json() as Record<string, unknown> } catch { return null }
    })()
    if (p === null || typeof p !== 'object' || Array.isArray(p)) {
      return c.json({ error: 'invalid_body', message: 'JSON 객체를 보내주세요.' }, 400)
    }
    const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
    const startDate = str(p.startDate)
    const endDate = str(p.endDate)
    const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v)
    if (!isDate(startDate) || !isDate(endDate)) {
      return c.json({ error: 'invalid_date', message: 'startDate·endDate 는 YYYY-MM-DD 여야 합니다.' }, 400)
    }
    if (endDate < startDate) {
      return c.json({ error: 'invalid_date', message: '종료일이 시작일보다 앞설 수 없습니다.' }, 400)
    }
    // 기간 상한 — 없으면 한 요청이 후보 전체를 몇십 번 훑는다.
    const nights = (Date.parse(endDate) - Date.parse(startDate)) / 86400000
    if (nights > 13) {
      return c.json({ error: 'invalid_date', message: '추천은 최대 14일까지 지원합니다.' }, 400)
    }

    const arr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()) : []
    const budget = str(p.budget)
    if (budget && !BUDGET_CODES.has(budget)) {
      return c.json({ error: 'invalid_budget', message: 'budget 은 low·medium·high 중 하나여야 합니다.' }, 400)
    }
    const themes = arr(p.themes)
    const unknownThemes = themes.filter((t) => !THEME_CODES.has(t))
    if (unknownThemes.length) {
      return c.json({
        error: 'invalid_themes',
        message: `알 수 없는 테마입니다: ${unknownThemes.join(', ')}. GET /v1/plan-options 로 목록을 확인하세요.`,
      }, 400)
    }

    const input: RecommendInput = {
      region: str(p.region) || undefined,
      regionCode: str(p.regionCode) || undefined,
      sigunguCode: str(p.sigunguCode) || undefined,
      startDate, endDate,
      party: arr(p.party) as PartyKind[],
      themes,
      budget: (budget || undefined) as RecommendInput['budget'],
      dayTripOnly: p.dayTripOnly === true,
    }
    if (!input.region && !input.regionCode) {
      return c.json({ error: 'missing_region', message: 'region(슬러그) 또는 regionCode 가 필요합니다.' }, 400)
    }

    const result = await recommend(input)
    // 후보가 아예 없으면 200 이 아니라 404 다. 빈 코스는 "갈 곳이 없다" 로 읽힌다.
    if (result && result.notes.includes('empty_pool')) {
      return c.json({
        error: 'no_candidates',
        message: '이 지역에는 추천할 장소가 충분하지 않습니다. 다른 지역을 선택해주세요.',
        region: result.region,
      }, 404)
    }
    // 알 수 없는 슬러그를 조용히 전국 검색으로 흘리지 않는다 — 엉뚱한 코스가 나가는 것이 더 나쁘다.
    if (!result) {
      return c.json({
        error: 'unknown_region',
        message: '알 수 없는 지역입니다. regionCode(ldong_regn_cd)로 보내거나 지원 지역을 확인해주세요.',
      }, 400)
    }
    return c.json(result)
  })

  const MAX_PLAN_TITLE = 60
  const MAX_PLAN_DAYS = 60
  const MAX_ITEMS_PER_DAY = 60

  // 플랜 저장 — 신규 생성과 수정을 하나로 다룬다.
  //  본문(days/items)은 **통째로 교체**한다. 편집 화면에서 순서 바꾸기·장소 추가·메모가
  //  한꺼번에 일어나므로, 부분 갱신 API 를 여러 개 두면 클라이언트가 호출 순서를 맞추다
  //  중간 상태가 저장되는 사고가 난다. 한 트랜잭션에 다 넣으면 그럴 일이 없다.
  v1.put('/plans/:planId', async (c) => {
    const planId = c.req.param('planId')
    if (!/^[0-9a-fA-F-]{36}$/.test(planId)) {
      return c.json({ error: 'invalid_planId', message: 'planId 는 UUID 여야 합니다.' }, 400)
    }

    let payload: unknown
    try {
      payload = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_json', message: 'JSON 본문을 파싱할 수 없습니다.' }, 400)
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return c.json({ error: 'invalid_body', message: 'JSON 객체를 보내주세요.' }, 400)
    }
    const p = payload as Record<string, unknown>
    const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

    const authorNm = str(p.authorNm)
    const title = str(p.title)
    const startDate = str(p.startDate)
    const endDate = str(p.endDate)

    const gate = requireAuth(c)
    if (gate instanceof Response) return gate
    if (!title) return c.json({ error: 'missing_title', message: '플랜 제목은 비어 있을 수 없습니다.' }, 400)
    if (title.length > MAX_PLAN_TITLE) {
      return c.json({ error: 'invalid_title', message: `제목은 ${MAX_PLAN_TITLE}자 이하여야 합니다.` }, 400)
    }
    const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)
    if (!isDate(startDate) || !isDate(endDate)) {
      return c.json({ error: 'invalid_date', message: 'startDate·endDate 는 YYYY-MM-DD 여야 합니다.' }, 400)
    }
    if (endDate < startDate) {
      return c.json({ error: 'invalid_date', message: '종료일이 시작일보다 앞설 수 없습니다.' }, 400)
    }

    // 테마 — 화이트리스트 밖 코드는 조용히 버리지 않고 400 으로 알린다.
    //  사용자가 고른 것이 사라진 이유를 알 수 없는 편이 더 나쁘다(후기 태그와 같은 규칙).
    let themes: string[] = []
    if (p.themes != null) {
      if (!Array.isArray(p.themes) || p.themes.some((v) => typeof v !== 'string')) {
        return c.json({ error: 'invalid_themes', message: 'themes 는 문자열 배열이어야 합니다.' }, 400)
      }
      themes = [...new Set((p.themes as string[]).map((v) => v.trim()).filter(Boolean))]
      const unknown = themes.filter((v) => !THEME_CODES.has(v))
      if (unknown.length) {
        return c.json({
          error: 'invalid_themes',
          message: `알 수 없는 테마입니다: ${unknown.join(', ')}. GET /v1/plan-options 로 목록을 확인하세요.`,
        }, 400)
      }
    }

    // 예산 — 건너뛰면 null 이다. "고르지 않음"과 "저예산"은 다른 값이라 기본값을 넣지 않는다.
    const budget = str(p.budget) || null
    if (budget && !BUDGET_CODES.has(budget)) {
      return c.json({
        error: 'invalid_budget',
        message: `budget 은 ${[...BUDGET_CODES].join('/')} 중 하나여야 합니다.`,
      }, 400)
    }

    const dayTripOnly = p.dayTripOnly === true

    const rawDays = Array.isArray(p.days) ? p.days : []
    if (rawDays.length > MAX_PLAN_DAYS) {
      return c.json({ error: 'too_many_days', message: `하루 수는 ${MAX_PLAN_DAYS}일 이하여야 합니다.` }, 400)
    }
    for (const d of rawDays) {
      const items = (d as Record<string, unknown>)?.items
      if (Array.isArray(items) && items.length > MAX_ITEMS_PER_DAY) {
        return c.json({ error: 'too_many_items', message: `하루 항목은 ${MAX_ITEMS_PER_DAY}개 이하여야 합니다.` }, 400)
      }
    }

    try {
      await withTransaction(async (client) => {
        // 작성자는 세션의 계정이다(030). 닉네임을 보냈으면 갱신한다.
        const author = (await client.query<{ id: number }>(
          `update authors set nickname = coalesce(nullif($2, ''), nickname)
            where id = $1 returning id`, [gate.authorId, authorNm],
        )).rows[0]
        if (!author) throw new Error('author_missing')

        // 남의 플랜을 덮어쓰지 못하게 소유자까지 조건에 넣는다. 이미 있는데 주인이 다르면
        // 아래 upsert 가 0행을 갱신하고, 그 사실을 rowCount 로 잡아 403 을 낸다.
        const upserted = await client.query(
          `insert into plans (id, author_id, title, start_date, end_date, region, party,
                              cover_image_url, themes, budget, day_trip_only)
           values ($1, $2, $3, $4, $5, $6, coalesce($7::jsonb, '{}'::jsonb), $8, $9, $10, $11)
           on conflict (id) do update
             set title = excluded.title, start_date = excluded.start_date,
                 end_date = excluded.end_date, region = excluded.region,
                 party = excluded.party, cover_image_url = excluded.cover_image_url,
                 themes = excluded.themes, budget = excluded.budget,
                 day_trip_only = excluded.day_trip_only,
                 updated_at = now()
           where plans.author_id = $2`,
          [planId, author.id, title, startDate, endDate,
           str(p.region) || null, JSON.stringify(p.party ?? {}), str(p.coverImageURL) || null,
           themes, budget, dayTripOnly],
        )
        if (upserted.rowCount === 0) throw new Error('forbidden')

        // days/items 통째 교체. cascade 로 items 까지 함께 지워진다.
        await client.query('delete from plan_days where plan_id = $1', [planId])

        for (const [dayIndex, rawDay] of rawDays.entries()) {
          const d = rawDay as Record<string, unknown>
          const dayId = str(d.id) || randomUUID()
          const date = str(d.date)
          if (!isDate(date)) throw new Error('invalid_day_date')

          await client.query(
            'insert into plan_days (id, plan_id, date, position) values ($1, $2, $3, $4)',
            [dayId, planId, date, dayIndex],
          )

          const items = Array.isArray(d.items) ? d.items : []
          for (const [itemIndex, rawItem] of items.entries()) {
            const it = rawItem as Record<string, unknown>
            const kind = str(it.kind)
            const itemId = str(it.id) || randomUUID()

            if (kind === 'memo') {
              const text = str(it.text)
              if (!text) throw new Error('empty_memo')
              await client.query(
                `insert into plan_items (id, day_id, position, kind, memo_text)
                 values ($1, $2, $3, 'memo', $4)`,
                [itemId, dayId, itemIndex, text],
              )
            } else if (kind === 'stop') {
              const place = (it.place ?? {}) as Record<string, unknown>
              const name = str(place.name)
              if (!name) throw new Error('empty_place_name')
              await client.query(
                `insert into plan_items
                   (id, day_id, position, kind, content_id, place_name, category_label,
                    category, region, image_url, latitude, longitude)
                 values ($1, $2, $3, 'stop', $4, $5, $6, $7, $8, $9, $10, $11)`,
                [itemId, dayId, itemIndex, str(place.contentID) || null, name,
                 str(place.categoryLabel) || '장소', str(place.category) || null,
                 str(place.region) || null, str(place.imageURL) || null,
                 typeof place.latitude === 'number' ? place.latitude : null,
                 typeof place.longitude === 'number' ? place.longitude : null],
              )
            } else {
              throw new Error('invalid_kind')
            }
          }
        }
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : ''
      if (reason === 'forbidden') {
        return c.json({ error: 'forbidden', message: '다른 기기의 플랜은 저장할 수 없습니다.' }, 403)
      }
      if (reason === 'invalid_day_date') {
        return c.json({ error: 'invalid_date', message: 'days[].date 는 YYYY-MM-DD 여야 합니다.' }, 400)
      }
      if (reason === 'empty_memo') {
        return c.json({ error: 'invalid_item', message: '메모 내용은 비어 있을 수 없습니다.' }, 400)
      }
      if (reason === 'empty_place_name') {
        return c.json({ error: 'invalid_item', message: '장소 이름은 비어 있을 수 없습니다.' }, 400)
      }
      if (reason === 'invalid_kind') {
        return c.json({ error: 'invalid_item', message: "kind 는 'stop' 또는 'memo' 여야 합니다." }, 400)
      }
      throw error
    }

    const saved = (await query<Record<string, unknown>>(`${PLAN_SELECT} where p.id = $1`, [planId])).rows[0]!
    return c.json({ ...saved, days: await loadDays(planId) })
  })

  // 플랜 삭제 — 목록 카드의 ⋮ 메뉴가 쓸 자리다.
  //  days/items 는 cascade 로 함께 지워진다(021 의 on delete cascade).
  //  ⚠️ 되돌릴 수 없다. 휴지통을 두지 않는 이유는 플랜이 사용자가 직접 만든 소수의 데이터라
  //     실수로 지웠을 때 다시 만드는 비용이 크지 않고, 소프트 삭제를 도입하면 목록·상세 조회에
  //     전부 조건이 붙어 실수할 여지가 늘기 때문이다.
  v1.delete('/plans/:planId', async (c) => {
    const gate = requireAuth(c)
    if (gate instanceof Response) return gate

    const authorId: number | null = gate.authorId
    // 남의 플랜과 없는 플랜을 구분해 주지 않는다 — 조회와 같은 규칙이다.
    if (authorId == null) return c.json({ error: 'not_found', message: '플랜을 찾을 수 없습니다.' }, 404)

    const result = await query(
      'delete from plans where id = $1 and author_id = $2',
      [c.req.param('planId'), authorId],
    )
    if (result.rowCount === 0) return c.json({ error: 'not_found', message: '플랜을 찾을 수 없습니다.' }, 404)
    return c.body(null, 204)
  })

  /**
   * 플랜을 일정으로 확정한다 / 초안으로 되돌린다 — 시안 플랜 카드 ⋮ 의 "일정에 추가"(553:135).
   *
   * PUT 으로 하지 않는 이유가 분명하다: `PUT /v1/plans/:id` 는 본문을 **통째로 교체**하므로
   * 확정 하나 바꾸자고 부르려면 온전한 플랜(days 포함)을 먼저 받아 와야 하고, 목록에서 온 플랜을
   * 실수로 넘기면 서버의 일정이 지워진다. 상태 한 칸만 바꾸는 길을 따로 낸다.
   *
   * 되돌리기(DELETE)를 함께 두는 이유: 확정이 한 방향뿐이면 잘못 누른 플랜이 플랜 탭에서
   * 영영 사라진다. 시안에 되돌리는 버튼은 없지만 길 자체를 막아 둘 이유가 없다.
   */
  type ConfirmResult =
    | { ok: true; plan: Record<string, unknown> }
    | { ok: false; error: 'login_required' | 'not_found' }

  const applyConfirm = async (
    c: Context<AppEnv>, planId: string, confirmed: boolean,
  ): Promise<ConfirmResult> => {
    const authorId = authorOf(c)
    if (authorId == null) return { ok: false, error: 'login_required' }

    // 이미 같은 상태여도 성공으로 둔다 — 두 번 눌렀다고 실패를 보여 줄 이유가 없다.
    //  coalesce 로 처음 확정한 시각을 지킨다(다시 눌러도 시각이 밀리지 않는다).
    const result = await query(
      `update plans set confirmed_at = ${confirmed ? 'coalesce(confirmed_at, now())' : 'null'},
                        updated_at = now()
        where id = $1 and author_id = $2`,
      [planId, authorId],
    )
    if (result.rowCount === 0) return { ok: false, error: 'not_found' }

    const plan = (await query<Record<string, unknown>>(
      `${PLAN_SELECT} where p.id = $1 and p.author_id = $2`, [planId, authorId],
    )).rows[0]!
    return { ok: true, plan: { ...plan, days: await loadDays(plan.id as string) } }
  }

  const confirmMessages = {
    login_required: '로그인이 필요합니다.',
    not_found: '플랜을 찾을 수 없습니다.',
  } as const

  const respondConfirm = async (c: Context, confirmed: boolean) => {
    const r = await applyConfirm(c, c.req.param('planId') ?? '', confirmed)
    if (r.ok) return c.json(r.plan)
    return c.json(
      { error: r.error, message: confirmMessages[r.error] },
      r.error === 'login_required' ? 401 : 404,
    )
  }

  v1.post('/plans/:planId/confirm', (c) => respondConfirm(c, true))
  v1.delete('/plans/:planId/confirm', (c) => respondConfirm(c, false))

  // ── 저장한 장소(북마크) ──────────────────────────────────────────────────────

  /**
   * 저장 목록 — 카드가 쓰는 값이 무장애 목록과 같아서 `BF_COLS` 를 그대로 돌려준다.
   * 앱이 목록·검색과 같은 디코딩을 재사용할 수 있다.
   *
   * 평점은 barrier_free 에 없다(원본에 그런 값이 없다). 후기에서 집계해 얹는다 —
   * 시안 카드에 별점이 있고, 그 값을 낼 수 있는 곳이 후기뿐이다.
   */
  v1.get('/saved-places', async (c) => {
    const gate = requireAuth(c)
    if (gate instanceof Response) return gate

    const authorId: number | null = gate.authorId
    if (authorId == null) return c.json({ count: 0, items: [] })

    const rows = (await query(
      `select ${BF_COLS},
              s.created_at as "savedAt",
              r.avg_rating as "avgRating", r.review_count as "reviewCount"
         from saved_places s
         join barrier_free b on b.contentid = s.content_id
         left join lateral (
           select round(avg(rating)::numeric, 1)::float8 as avg_rating, count(*)::int as review_count
             from reviews where content_id = s.content_id and rating is not null
         ) r on true
        where s.author_id = $1
        order by s.created_at desc`, [authorId],
    )).rows
    return c.json({ count: rows.length, items: rows })
  })

  /** 저장. 이미 저장돼 있어도 성공으로 둔다 — 두 번 눌렀다고 실패를 보여 줄 이유가 없다. */
  v1.put('/saved-places/:contentId', async (c) => {
    const gate = requireAuth(c)
    if (gate instanceof Response) return gate

    const contentId = c.req.param('contentId') ?? ''
    const exists = (await query('select 1 from barrier_free where contentid = $1', [contentId])).rowCount
    if (!exists) return c.json({ error: 'not_found', message: '장소를 찾을 수 없습니다.' }, 404)

    const authorId = gate.authorId
    await query(
      `insert into saved_places (author_id, content_id) values ($1, $2)
       on conflict (author_id, content_id) do nothing`, [authorId, contentId],
    )
    return c.json({ contentId, saved: true })
  })

  v1.delete('/saved-places/:contentId', async (c) => {
    const gate = requireAuth(c)
    if (gate instanceof Response) return gate

    const authorId: number | null = gate.authorId
    const contentId = c.req.param('contentId') ?? ''
    // 저장한 적 없는 장소를 지워도 성공이다 — 결과("저장돼 있지 않다")가 같다.
    if (authorId != null) {
      await query('delete from saved_places where author_id = $1 and content_id = $2',
        [authorId, contentId])
    }
    return c.json({ contentId, saved: false })
  })

  // ── 여행 게시글 ─────────────────────────────────────────────────────────────

  /** 게시글 본문 상한. 후기(2000)보다 넉넉하다 — 게시글은 글 자체가 목적이다. */
  const MAX_POST_BODY = 5000
  const MAX_POST_PLACES = 20
  const MAX_POST_IMAGES = 5

  /** 목록·단건 공통 select. 붙인 장소는 별도 쿼리로 모아 붙인다(N+1 회피). */
  /// $1 은 **보는 사람의 author_id**(없으면 null) — "내가 좋아요를 눌렀나"를 함께 준다.
  ///  숫자만 주면 버튼이 눌린 상태를 그릴 수 없다.
  const POST_SELECT = `
    select p.id, p.body, p.image_urls as "imageURLs",
           p.access_features as "accessFeatures",
           a.nickname as author,
           (select count(*)::int from post_likes pl where pl.post_id = p.id) as "likeCount",
           (select count(*)::int from post_comments pc where pc.post_id = p.id) as "commentCount",
           exists (
             select 1 from post_likes pl
              where pl.post_id = p.id and pl.author_id = $VIEWER
           ) as "likedByMe",
           to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "createdAt",
           to_char(p.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "updatedAt"
      from posts p
      join authors a on a.id = p.author_id`

  /** 보는 사람 자리를 실제 파라미터 번호로 바꿔 준다. */
  const postSelect = (viewerParam: number) =>
    POST_SELECT.replace('$VIEWER', `$${viewerParam}`)

  /** 여러 게시글의 장소를 한 방에 읽어 id 별로 묶는다. */
  const loadPostPlaces = async (postIds: string[]) => {
    const map = new Map<string, unknown[]>()
    if (!postIds.length) return map
    const rows = (await query<{
      post_id: string; content_id: string; place_name: string; region: string | null
    }>(
      `select post_id, content_id, place_name, region
         from post_places where post_id = any($1::uuid[]) order by post_id, position`,
      [postIds],
    )).rows
    for (const r of rows) {
      if (!map.has(r.post_id)) map.set(r.post_id, [])
      map.get(r.post_id)!.push({ contentID: r.content_id, name: r.place_name, region: r.region })
    }
    return map
  }

  // 최근 글부터.
  //
  //  ⚠️ **세션은 "보는 사람"일 뿐 목록을 좁히지 않는다.** 예전에는 deviceId 가 있으면
  //  내 글만 주도록 했는데, 그러면 `likedByMe` 를 채우려고 신원을 실은 순간 목록이
  //  내 글로 좁혀져 버린다. 그래서 클라이언트는 전체 목록에 신원을 못 실었고,
  //  viewerId 가 늘 null 이 되어 **하트가 어디서도 눌린 상태로 그려지지 않았다**
  //  (`author_id = null` 은 절대 참이 아니다, 2026-08-18 확인). 두 뜻을 갈라 놓는다:
  //   - 세션     : 보는 사람 (하트가 눌렸는지). 비로그인이면 전부 false
  //   - mine     : 그 기기가 쓴 글만
  //   - liked    : 그 기기가 좋아요한 글만 (저장 탭의 "좋아요한 게시물")
  //   - contentId: 그 장소를 붙인 글만 (장소 후기 화면의 "여행 게시글" 탭)
  v1.get('/posts', async (c) => {
    const { limit, offset } = paging(c)
    const contentId = c.req.query('contentId')?.trim()
    const mine = c.req.query('mine') === 'true'
    const liked = c.req.query('liked') === 'true'

    // 보는 사람 = 세션의 계정. 비로그인 요청은 null 이고 likedByMe 가 전부 false 가 된다.
    //  목록 자체는 공개다 — 둘러보기는 로그인 없이 되어야 한다(앱스토어 심사 고려 포함).
    const viewerId = authorOf(c)
    // 내 것을 묻는 필터(mine·liked)는 사람이 있어야 성립한다.
    if ((mine || liked) && viewerId == null) {
      return c.json({ error: 'login_required', message: '로그인이 필요합니다.' }, 401)
    }

    const conditions: string[] = []
    const params: unknown[] = [viewerId]
    // 내 것을 묻는 필터는 사람이 있어야 성립한다. 아직 아무것도 쓴 적 없는 기기라
    // authors 행이 없으면 결과는 빈 목록이 맞다 — 전체 목록을 주면 안 된다.
    if ((mine || liked) && viewerId == null) return c.json({ count: 0, limit, offset, items: [] })
    if (mine) conditions.push(`p.author_id = $1`)
    if (liked) {
      conditions.push(`exists (select 1 from post_likes pl where pl.post_id = p.id and pl.author_id = $1)`)
    }
    if (contentId) {
      params.push(contentId)
      // exists 로 묻는다 — join 하면 한 글에 같은 장소가 여러 번 붙었을 때 글이 중복된다.
      conditions.push(
        `exists (select 1 from post_places pp where pp.post_id = p.id and pp.content_id = $${params.length})`)
    }
    const where = conditions.length ? `where ${conditions.join(' and ')}` : ''

    // 좋아요 목록은 **내가 누른 순서**로 본다 — 글이 쓰인 시각이 아니라 내가 담은 시각이
    //  그 목록의 축이다(저장 목록이 저장한 순서인 것과 같다). POST_SELECT 를 건드리지 않고
    //  order by 안에서 묻는다.
    const order = liked
      ? `(select pl.created_at from post_likes pl
            where pl.post_id = p.id and pl.author_id = $1) desc`
      : `p.created_at desc`

    const rows = (await query<Record<string, unknown>>(
      `${postSelect(1)} ${where} order by ${order} limit ${limit} offset ${offset}`, params,
    )).rows
    const places = await loadPostPlaces(rows.map((r) => r.id as string))
    const items = rows.map((r) => ({ ...r, places: places.get(r.id as string) ?? [] }))
    return c.json({ count: items.length, limit, offset, items })
  })

  v1.get('/posts/:postId', async (c) => {
    const postId = c.req.param('postId') ?? ''
    // 보는 사람 = 세션의 계정. 비로그인이면 null 이고 likedByMe 는 false 가 된다.
    const viewerId = authorOf(c)
    const post = (await query<Record<string, unknown>>(
      `${postSelect(2)} where p.id = $1`, [postId, viewerId],
    )).rows[0]
    if (!post) return c.json({ error: 'not_found', message: '게시글을 찾을 수 없습니다.' }, 404)
    return c.json({ ...post, places: (await loadPostPlaces([postId])).get(postId) ?? [] })
  })

  /**
   * 게시글 작성.
   *
   * 후기와 같은 규칙으로 작성자를 확보한다 — 글은 사람에게 귀속되는 내용이라 **닉네임이 필요하다**.
   * 저장만 한 기기(빈 닉네임)도 여기서는 이름을 요구한다(`needsNickname` 참고).
   */
  v1.post('/posts', async (c) => {
    let payload: unknown
    try {
      payload = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_json', message: 'JSON 본문을 파싱할 수 없습니다.' }, 400)
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return c.json({ error: 'invalid_body', message: 'JSON 객체를 보내주세요.' }, 400)
    }
    const p = payload as Record<string, unknown>
    const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

    const authorNm = str(p.authorNm)
    const body = str(p.body)
    const gate = requireAuth(c)
    if (gate instanceof Response) return gate
    if (!body) return c.json({ error: 'missing_body', message: '내용은 비어 있을 수 없습니다.' }, 400)
    if (body.length > MAX_POST_BODY) {
      return c.json({ error: 'body_too_long', message: `내용은 ${MAX_POST_BODY}자 이하여야 합니다.` }, 400)
    }

    const imageURLs = Array.isArray(p.imageURLs) ? p.imageURLs.filter((u) => typeof u === 'string') : []
    if (imageURLs.length > MAX_POST_IMAGES) {
      return c.json({ error: 'too_many_images', message: `사진은 ${MAX_POST_IMAGES}장 이하여야 합니다.` }, 400)
    }

    // 무장애 정보. 값을 검증하지 않는다 — 앱이 아이콘을 늘리면 서버 배포 없이 따라가야 하고,
    // 모르는 코드는 앱이 뱃지를 안 그리면 그만이다(plans.themes 와 같은 판단).
    const accessFeatures = Array.isArray(p.accessFeatures)
      ? [...new Set(p.accessFeatures.filter((v) => typeof v === 'string' && v.trim()).map(String))].slice(0, 10)
      : []

    const rawPlaces = Array.isArray(p.places) ? p.places : []
    if (rawPlaces.length > MAX_POST_PLACES) {
      return c.json({ error: 'too_many_places', message: `장소는 ${MAX_POST_PLACES}곳 이하여야 합니다.` }, 400)
    }
    const places = rawPlaces.map((v) => {
      const o = (v ?? {}) as Record<string, unknown>
      return { contentID: str(o.contentID), name: str(o.name), region: str(o.region) }
    })
    if (places.some((pl) => !pl.contentID || !pl.name)) {
      return c.json({ error: 'invalid_place', message: '장소는 contentID 와 name 이 필요합니다.' }, 400)
    }


    const postId = await withTransaction(async (client) => {
      // 작성자는 세션의 계정이다(030). 닉네임을 보냈으면 갱신한다.
      const author = (await client.query<{ id: number }>(
        `update authors set nickname = coalesce(nullif($2, ''), nickname)
          where id = $1 returning id`, [gate.authorId, authorNm],
      )).rows[0]!

      const created = (await client.query<{ id: string }>(
        `insert into posts (author_id, body, image_urls, access_features)
         values ($1, $2, $3, $4) returning id`,
        [author.id, body, imageURLs, accessFeatures],
      )).rows[0]!

      for (const [index, pl] of places.entries()) {
        await client.query(
          `insert into post_places (post_id, position, content_id, place_name, region)
           values ($1, $2, $3, $4, $5)`,
          [created.id, index, pl.contentID, pl.name, pl.region || null],
        )
      }
      return created.id
    })

    const post = (await query<Record<string, unknown>>(
      `${postSelect(2)} where p.id = $1`, [postId, gate.authorId],
    )).rows[0]!
    return c.json({ ...post, places: (await loadPostPlaces([postId])).get(postId) ?? [] }, 201)
  })

  v1.delete('/posts/:postId', async (c) => {
    const gate = requireAuth(c)
    if (gate instanceof Response) return gate
    const authorId: number | null = gate.authorId
    if (authorId == null) return c.json({ error: 'not_found', message: '게시글을 찾을 수 없습니다.' }, 404)

    const result = await query('delete from posts where id = $1 and author_id = $2',
      [c.req.param('postId'), authorId])
    if (result.rowCount === 0) return c.json({ error: 'not_found', message: '게시글을 찾을 수 없습니다.' }, 404)
    return c.body(null, 204)
  })

  // ── 게시글 좋아요 ───────────────────────────────────────────────────────────

  /**
   * 좋아요 켜기/끄기. 둘 다 멱등이다 — 두 번 눌렀다고 실패를 보여 줄 이유가 없다.
   *
   * 좋아요는 **이름이 필요 없는 행동**이라 닉네임을 묻지 않는다(저장과 같은 판단) —
   * 하트 하나 누르자고 이름을 요구하면 대부분은 그냥 떠난다.
   */
  const setPostLike = async (c: Context, liked: boolean) => {
    const gate = requireAuth(c)
    if (gate instanceof Response) return gate

    const postId = c.req.param('postId') ?? ''
    const exists = (await query('select 1 from posts where id = $1', [postId])).rowCount
    if (!exists) return c.json({ error: 'not_found', message: '게시글을 찾을 수 없습니다.' }, 404)

    if (liked) {
      const authorId = gate.authorId
      await query(
        `insert into post_likes (post_id, author_id) values ($1, $2)
         on conflict (post_id, author_id) do nothing`, [postId, authorId])
    } else {
      const authorId: number | null = gate.authorId
      if (authorId != null) {
        await query('delete from post_likes where post_id = $1 and author_id = $2', [postId, authorId])
      }
    }

    const count = (await query<{ n: number }>(
      'select count(*)::int n from post_likes where post_id = $1', [postId])).rows[0]!.n
    return c.json({ postId, likedByMe: liked, likeCount: count })
  }

  v1.put('/posts/:postId/like', (c) => setPostLike(c, true))
  v1.delete('/posts/:postId/like', (c) => setPostLike(c, false))

  // ── 후기 좋아요(038) ─────────────────────────────────────────────────────────
  //  게시글과 같은 규칙이되, like_count 컬럼을 캐시로 두고 ±1 한다(038 주석).
  const setReviewLike = async (c: Context, liked: boolean) => {
    const gate = requireAuth(c)
    if (gate instanceof Response) return gate

    const reviewId = c.req.param('reviewId') ?? ''
    // reviews.id 는 bigserial(정수)다. 숫자가 아니면 bigint 캐스팅에서 터지므로 먼저 막는다.
    if (!/^\d+$/.test(reviewId)) {
      return c.json({ error: 'invalid_reviewId', message: 'reviewId 는 숫자여야 합니다.' }, 400)
    }
    const exists = (await query('select 1 from reviews where id = $1', [reviewId])).rowCount
    if (!exists) return c.json({ error: 'not_found', message: '후기를 찾을 수 없습니다.' }, 404)

    if (liked) {
      // 실제로 삽입됐을 때만(중복 좋아요가 아닐 때만) 카운트를 올린다.
      const r = await query(
        `insert into review_likes (review_id, author_id) values ($1, $2)
         on conflict (review_id, author_id) do nothing`, [reviewId, gate.authorId])
      if (r.rowCount) await query('update reviews set like_count = like_count + 1 where id = $1', [reviewId])
    } else {
      const r = await query(
        'delete from review_likes where review_id = $1 and author_id = $2', [reviewId, gate.authorId])
      // 시드값 위에 누적하므로 0 밑으로는 내려가지 않게 막는다.
      if (r.rowCount) await query('update reviews set like_count = greatest(like_count - 1, 0) where id = $1', [reviewId])
    }

    const count = (await query<{ n: number }>(
      'select like_count as n from reviews where id = $1', [reviewId])).rows[0]!.n
    return c.json({ reviewId: Number(reviewId), likedByMe: liked, likeCount: count })
  }

  v1.put('/reviews/:reviewId/like', (c) => setReviewLike(c, true))
  v1.delete('/reviews/:reviewId/like', (c) => setReviewLike(c, false))

  // ── 게시글 댓글 ─────────────────────────────────────────────────────────────

  const POST_COMMENT_SELECT = `
    select c.id, a.nickname as author, c.body,
           to_char(c.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "createdAt"
      from post_comments c
      join authors a on a.id = c.author_id`

  // 오래된 순 — 대화 순서다(리뷰 댓글과 같다).
  v1.get('/posts/:postId/comments', async (c) => {
    const { limit, offset } = paging(c)
    const postId = c.req.param('postId') ?? ''
    const total = (await query<{ n: number }>(
      'select count(*)::int n from post_comments where post_id = $1', [postId])).rows[0]!.n
    const rows = (await query(
      `${POST_COMMENT_SELECT} where c.post_id = $1
        order by c.created_at limit ${limit} offset ${offset}`, [postId],
    )).rows
    return c.json({ total, limit, offset, count: rows.length, items: rows })
  })

  /** 댓글은 사람에게 귀속되는 글이라 **닉네임이 필요하다**(좋아요와 다르다). */
  v1.post('/posts/:postId/comments', async (c) => {
    let payload: unknown
    try {
      payload = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_json', message: 'JSON 본문을 파싱할 수 없습니다.' }, 400)
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return c.json({ error: 'invalid_body', message: 'JSON 객체를 보내주세요.' }, 400)
    }
    const p = payload as Record<string, unknown>
    const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

    const authorNm = str(p.authorNm)
    const body = str(p.body)
    const gate = requireAuth(c)
    if (gate instanceof Response) return gate
    if (!body) return c.json({ error: 'missing_body', message: '댓글은 비어 있을 수 없습니다.' }, 400)
    if (body.length > 1000) {
      return c.json({ error: 'body_too_long', message: '댓글은 1000자 이하여야 합니다.' }, 400)
    }

    const postId = c.req.param('postId') ?? ''
    const exists = (await query('select 1 from posts where id = $1', [postId])).rowCount
    if (!exists) return c.json({ error: 'not_found', message: '게시글을 찾을 수 없습니다.' }, 404)


    const commentId = await withTransaction(async (client) => {
      // 작성자는 세션의 계정이다(030). 닉네임을 보냈으면 갱신한다.
      const author = (await client.query<{ id: number }>(
        `update authors set nickname = coalesce(nullif($2, ''), nickname)
          where id = $1 returning id`, [gate.authorId, authorNm],
      )).rows[0]!
      return (await client.query<{ id: string }>(
        'insert into post_comments (post_id, author_id, body) values ($1, $2, $3) returning id',
        [postId, author.id, body],
      )).rows[0]!.id
    })

    const comment = (await query<Record<string, unknown>>(
      `${POST_COMMENT_SELECT} where c.id = $1`, [commentId])).rows[0]!
    return c.json(comment, 201)
  })

  app.route('/v1', v1);

  // 수집 현황 대시보드 — 비밀번호가 설정된 경우에만 라우트를 연다.
  //  DASHBOARD_PASSWORD 를 깜빡한 채 배포했을 때 "인증 없는 대시보드"가 노출되는 것보다
  //  404 가 낫다. 활성화 여부는 기동 로그에 찍는다.
  if (config.dashboard.password) app.route('/dashboard', buildDashboard());

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => {
    console.error('[api] 오류:', err);
    return c.json({ error: 'internal_error' }, 500);
  });
  return app;
}
