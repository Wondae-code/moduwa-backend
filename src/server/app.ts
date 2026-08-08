// moduwa 관광 데이터 REST API — Hono
//  조회는 전부 읽기 전용. 예외적으로 리뷰(POST /v1/reviews)만 쓰기를 허용한다.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { config } from '../config';
import { query, withTransaction } from '../db';
import { apiKeyAuth, rateLimit } from './middleware';

// 페이지네이션 파라미터 파싱 (limit 1~100, offset ≥0)
function paging(c: { req: { query: (k: string) => string | undefined } }): { limit: number; offset: number } {
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 20) || 20));
  const offset = Math.max(0, Number(c.req.query('offset') ?? 0) || 0);
  return { limit, offset };
}

export function buildApp(): Hono {
  const app = new Hono();

  const origins = config.api.allowedOrigins;
  app.use('*', cors({
    origin: origins.includes('*') || origins.length === 0 ? '*' : origins,
    allowMethods: ['GET', 'POST', 'OPTIONS'], // POST 는 리뷰 작성(POST /v1/reviews) 전용
    allowHeaders: ['authorization', 'x-api-key', 'content-type'],
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
      'GET /v1/reviews?sort=recommended|latest&contentId=&limit=&offset=',
      'GET /v1/reviews/summary?contentId=',
      'POST /v1/reviews  {contentId?, locationNm, rating, body, authorNm, deviceId, imageURLs?}',
    ],
    source: '한국관광공사 TourAPI · data.go.kr (출처 표시 필요)',
  }));
  app.get('/health', async (c) => {
    try {
      await query('select 1');
      return c.json({ status: 'ok', db: 'up' });
    } catch {
      return c.json({ status: 'degraded', db: 'down' }, 503);
    }
  });

  // 이하 /v1/* 은 인증 + 레이트리밋 적용
  const v1 = new Hono();
  v1.use('*', apiKeyAuth);
  v1.use('*', rateLimit);

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
    has_image, has_access`;

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

    const wsql = where.length ? `where ${where.join(' and ')}` : '';
    const total = (await query<{ n: number }>(`select count(*)::int n from barrier_free ${wsql}`, params)).rows[0]!.n;
    const rows = (await query(
      `select ${BF_COLS} from barrier_free ${wsql} order by has_image desc, has_access desc, contentid limit ${limit} offset ${offset}`, params,
    )).rows;
    return c.json({ total, limit, offset, count: rows.length, items: rows });
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
      access_hearing: boolean | null; access_infant: boolean | null;
      rank: number; source: string;
    }>(`select b.contentid, b.title, b.addr1, b.firstimage, b.contenttypeid,
               b.has_access, b.access_wheelchair, b.access_visual, b.access_hearing, b.access_infant,
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
    const rows = (await query<{
      contentid: string; title: string | null; contenttypeid: string | null;
      addr1: string | null; firstimage: string | null;
      access_wheelchair: boolean; access_visual: boolean; access_hearing: boolean; access_infant: boolean;
    }>(
      `select contentid, title, contenttypeid, addr1, firstimage,
              access_wheelchair, access_visual, access_hearing, access_infant
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
      access: {
        wheelchair: r.access_wheelchair, visual: r.access_visual,
        hearing: r.access_hearing, infant: r.access_infant,
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
  const REVIEW_SELECT = `
    select r.id, r.content_id as "contentId", r.location_nm as location,
           r.author_nm as author, r.body, r.rating,
           r.like_count as "likeCount", r.comment_count as "commentCount",
           r.is_accessibility_verified as "isAccessibilityVerified",
           r.image_urls as "imageURLs",
           to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "createdAt",
           a.nickname as author_nickname,
           (select count(*)::int from reviews r2 where r2.author_id = r.author_id) as author_review_count
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
  v1.get('/reviews', async (c) => {
    const { limit, offset } = paging(c);
    const order = c.req.query('sort') === 'latest'
      ? 'r.created_at desc'
      : '(r.like_count + r.comment_count) desc, r.created_at desc'; // recommended(기본)
    const where: string[] = [];
    const params: unknown[] = [];
    const contentId = c.req.query('contentId');
    if (contentId) { params.push(contentId); where.push(`r.content_id = $${params.length}`); }
    const wsql = where.length ? `where ${where.join(' and ')}` : '';

    // count 도 같은 별칭(r)을 써서 wsql 을 그대로 공유한다.
    const total = (await query<{ n: number }>(`select count(*)::int n from reviews r ${wsql}`, params)).rows[0]!.n;
    const rows = (await query<ReviewRow>(
      `${REVIEW_SELECT} ${wsql} order by ${order} limit ${limit} offset ${offset}`, params,
    )).rows;
    return c.json({ total, limit, offset, count: rows.length, items: rows.map(shapeReview) });
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
    return c.json({
      contentId,
      avgRating: row.avg_rating,
      reviewCount: row.review_count,
      ratedCount: row.rated_count,
    });
  });

  // 리뷰 작성 — 유일한 쓰기 엔드포인트. 인증·레이트리밋은 /v1/* 공통(Bearer API 키) 그대로.
  //  로그인이 없으므로 작성자는 deviceId(기기 UUID) + 닉네임으로 식별한다(017 설계 의도 참고).
  //  ⚠️ deviceId 는 응답에 절대 포함하지 않는다.
  const MAX_BODY_LEN = 2000;
  const MAX_IMAGES = 5;      // 앱 리뷰 카드가 1~5장 레이아웃 기준(014 참고)
  const MAX_NICKNAME_LEN = 40;

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

    const deviceId = str(p.deviceId);
    const locationNm = str(p.locationNm);
    const bodyText = str(p.body);
    const authorNm = str(p.authorNm);
    const contentId = str(p.contentId) || null;
    const rating = p.rating;

    if (!deviceId) return c.json({ error: 'missing_deviceId', message: 'deviceId(기기 식별자)는 필수입니다.' }, 400);
    if (deviceId.length > 128) return c.json({ error: 'invalid_deviceId', message: 'deviceId 는 128자 이하여야 합니다.' }, 400);
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

    // 처음 쓰는 기기라면 닉네임이 반드시 있어야 한다(authors.nickname 은 not null).
    // 이미 아는 기기면 닉네임 생략 가능 — 기존 닉네임을 그대로 재사용한다.
    const known = (await query<{ id: number }>('select id from authors where device_id = $1', [deviceId])).rows[0];
    if (!known && !authorNm) {
      return c.json({ error: 'missing_authorNm', message: '처음 작성하는 기기입니다. authorNm(닉네임)을 함께 보내주세요.' }, 400);
    }

    const newId = await withTransaction(async (client) => {
      // 작성자 upsert — device_id 가 키. 닉네임을 보냈으면 갱신, 생략하면 기존 값 유지.
      const author = authorNm
        ? (await client.query<{ id: number; nickname: string }>(
            `insert into authors (device_id, nickname) values ($1, $2)
               on conflict (device_id) do update set nickname = excluded.nickname
             returning id, nickname`, [deviceId, authorNm],
          )).rows[0]
        : (await client.query<{ id: number; nickname: string }>(
            'select id, nickname from authors where device_id = $1', [deviceId],
          )).rows[0];
      // 위 사전 확인을 통과했으므로 정상 경로에서는 항상 존재한다(동시 삭제 시에만 없음).
      if (!author) throw new Error('author_upsert_failed');

      // author_nm 은 레거시 표시용 컬럼 — 정규화된 닉네임과 어긋나지 않게 같은 값을 넣는다.
      const inserted = (await client.query<{ id: number }>(
        `insert into reviews (content_id, location_nm, author_nm, author_id, body, rating, image_urls)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [contentId, locationNm, author.nickname, author.id, bodyText, rating, imageURLs],
      )).rows[0]!;
      return inserted.id;
    });

    const row = (await query<ReviewRow>(`${REVIEW_SELECT} where r.id = $1`, [newId])).rows[0]!;
    return c.json(shapeReview(row), 201);
  });

  app.route('/v1', v1);

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => {
    console.error('[api] 오류:', err);
    return c.json({ error: 'internal_error' }, 500);
  });
  return app;
}
