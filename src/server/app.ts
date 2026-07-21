// moduwa 관광 데이터 REST API (읽기 전용) — Hono
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { config } from '../config';
import { query } from '../db';
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
    allowMethods: ['GET', 'OPTIONS'],
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
      'GET /v1/search?q=&limit=&offset=',
      'GET /v1/reviews?sort=recommended|latest&contentId=&limit=&offset=',
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

  // 여행자 리뷰 — iOS TravelReview 필드명으로 매핑
  v1.get('/reviews', async (c) => {
    const { limit, offset } = paging(c);
    const order = c.req.query('sort') === 'latest'
      ? 'created_at desc'
      : '(like_count + comment_count) desc, created_at desc'; // recommended(기본)
    const where: string[] = [];
    const params: unknown[] = [];
    const contentId = c.req.query('contentId');
    if (contentId) { params.push(contentId); where.push(`content_id = $${params.length}`); }
    const wsql = where.length ? `where ${where.join(' and ')}` : '';

    const total = (await query<{ n: number }>(`select count(*)::int n from reviews ${wsql}`, params)).rows[0]!.n;
    const rows = (await query(
      `select id, content_id as "contentId", location_nm as location, author_nm as author, body,
              like_count as "likeCount", comment_count as "commentCount",
              is_accessibility_verified as "isAccessibilityVerified",
              image_urls as "imageURLs",
              to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "createdAt"
         from reviews ${wsql} order by ${order} limit ${limit} offset ${offset}`, params,
    )).rows;
    return c.json({ total, limit, offset, count: rows.length, items: rows });
  });

  app.route('/v1', v1);

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => {
    console.error('[api] 오류:', err);
    return c.json({ error: 'internal_error' }, 500);
  });
  return app;
}
