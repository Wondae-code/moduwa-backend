// moduwa 관광 데이터 REST API — Hono
//  조회는 전부 읽기 전용. 예외적으로 리뷰(POST /v1/reviews)만 쓰기를 허용한다.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { config } from '../config';
import { query, withTransaction } from '../db';
import { buildDashboard } from './dashboard';
import { apiKeyAuth, rateLimit } from './middleware';

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

export function buildApp(): Hono {
  const app = new Hono();

  const origins = config.api.allowedOrigins;
  app.use('*', cors({
    origin: origins.includes('*') || origins.length === 0 ? '*' : origins,
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], // 쓰기: 후기(POST) · 플랜(PUT/DELETE)
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
      'GET /v1/reviews?sort=recommended|likes|latest&contentId=&hasImage=&limit=&offset=',
      'GET /v1/reviews/summary?contentId=',
      'GET /v1/review-tags',
      'POST /v1/reviews  {contentId?, locationNm, rating, body, authorNm, deviceId, tags?, wouldRevisit?, imageURLs?}',
      'POST /v1/reviews/images  (multipart, 필드명 files, 최대 5장·장당 2MB)',
      'GET /v1/reviews/:reviewId/comments?limit=&offset=',
      'POST /v1/reviews/:reviewId/comments  {body, authorNm?, deviceId}',
      'GET /images/reviews/:name  (업로드된 후기 사진 — 인증 불필요)',
      'GET /v1/plan-options',
      'GET /v1/plans?deviceId=',
      'GET /v1/plans/:planId?deviceId=',
      'PUT /v1/plans/:planId  {deviceId, authorNm?, title, startDate, endDate, region?, party?, themes?, budget?, dayTripOnly?, coverImageURL?, days[]}',
      'DELETE /v1/plans/:planId?deviceId=',
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
        orderBy = `(${ACCESS_SCORE} - 3 * (not coalesce(has_image, false))::int) desc, contentid`;
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
    // mapx/mapy 를 함께 내보낸다 — 목록(`BF_COLS`)·상세는 이미 주는데 검색만 자기 select 를
    //  따로 써서 빠져 있었다. 이게 없으면 검색으로 담은 장소는 좌표가 없어 플랜 지도에 핀이
    //  안 찍히고 구간 거리도 못 낸다(클라이언트가 상세를 한 번 더 부르는 수밖에 없었다).
    const rows = (await query<{
      contentid: string; title: string | null; contenttypeid: string | null;
      addr1: string | null; firstimage: string | null;
      mapx: number | null; mapy: number | null;
      access_wheelchair: boolean; access_visual: boolean; access_hearing: boolean; access_infant: boolean;
    }>(
      `select contentid, title, contenttypeid, addr1, firstimage, mapx, mapy,
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
      // 목록·상세와 같은 표기 — mapx=경도, mapy=위도. 원본에 좌표가 없는 장소는 null 이다.
      mapx: r.mapx,
      mapy: r.mapy,
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
    const params: unknown[] = [];
    const contentId = c.req.query('contentId');
    if (contentId) { params.push(contentId); where.push(`r.content_id = $${params.length}`); }
    // 시안의 "사진/영상 후기만 보기". image_urls 가 null 인 행도 있어 coalesce 로 감싼다.
    if (c.req.query('hasImage') === 'true') where.push('coalesce(array_length(r.image_urls, 1), 0) > 0');
    const wsql = where.length ? `where ${where.join(' and ')}` : '';

    // count 도 같은 별칭(r)을 써서 wsql 을 그대로 공유한다.
    const total = (await query<{ n: number }>(`select count(*)::int n from reviews r ${wsql}`, params)).rows[0]!.n;
    const rows = (await query<ReviewRow>(
      `${REVIEW_SELECT} ${wsql} order by ${order} limit ${limit} offset ${offset}`, params,
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
  //  로그인이 없으므로 작성자는 deviceId(기기 UUID) + 닉네임으로 식별한다(017 설계 의도 참고).
  //  ⚠️ deviceId 는 응답에 절대 포함하지 않는다.
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

    const row = (await query<ReviewRow>(`${REVIEW_SELECT} where r.id = $1`, [newId])).rows[0]!;
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

    const deviceId = str(p.deviceId);
    const bodyText = str(p.body);
    const authorNm = str(p.authorNm);

    if (!deviceId) return c.json({ error: 'missing_deviceId', message: 'deviceId(기기 식별자)는 필수입니다.' }, 400);
    if (deviceId.length > 128) return c.json({ error: 'invalid_deviceId', message: 'deviceId 는 128자 이하여야 합니다.' }, 400);
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
    const known = (await query<{ id: number }>('select id from authors where device_id = $1', [deviceId])).rows[0];
    if (!known && !authorNm) {
      return c.json({ error: 'missing_authorNm', message: '처음 작성하는 기기입니다. authorNm(닉네임)을 함께 보내주세요.' }, 400);
    }

    const newId = await withTransaction(async (client) => {
      const author = authorNm
        ? (await client.query<{ id: number }>(
            `insert into authors (device_id, nickname) values ($1, $2)
               on conflict (device_id) do update set nickname = excluded.nickname
             returning id`, [deviceId, authorNm],
          )).rows[0]
        : (await client.query<{ id: number }>(
            'select id from authors where device_id = $1', [deviceId],
          )).rows[0];
      if (!author) throw new Error('author_upsert_failed');

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
  //  리뷰와 달리 **개인 데이터**다. 조회도 소유자(deviceId)로 좁히고, 남의 플랜은 보이지 않는다.
  //  플랜 본문(days/items)은 통째로 교체한다 — 순서 바꾸기·장소 추가·메모가 한 번에 일어나는
  //  편집이라 부분 갱신 API 를 여러 개 두면 클라이언트가 순서를 맞추다 어긋난다.

  /** deviceId 로 작성자를 찾는다. 없으면 null (플랜이 하나도 없는 기기다). */
  async function findAuthor(deviceId: string): Promise<number | null> {
    const row = (await query<{ id: number }>(
      'select id from authors where device_id = $1', [deviceId],
    )).rows[0];
    return row?.id ?? null;
  }

  /** 요청의 deviceId. 없으면 null 을 돌려주고 호출부가 400 을 낸다. */
  function deviceIdOf(c: { req: { query: (k: string) => string | undefined } }): string {
    return (c.req.query('deviceId') ?? '').trim();
  }

  const PLAN_SELECT = `
    select p.id, p.title,
           to_char(p.start_date, 'YYYY-MM-DD') as "startDate",
           to_char(p.end_date, 'YYYY-MM-DD')   as "endDate",
           p.region, p.party, p.cover_image_url as "coverImageURL",
           p.themes, p.budget, p.day_trip_only as "dayTripOnly",
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

  // 내 플랜 목록 — 최근 여행부터. 본문(days)은 싣지 않는다(목록 카드에 필요 없다).
  v1.get('/plans', async (c) => {
    const deviceId = deviceIdOf(c);
    if (!deviceId) return c.json({ error: 'missing_deviceId', message: 'deviceId 는 필수입니다.' }, 400);

    const authorId = await findAuthor(deviceId);
    if (authorId == null) return c.json({ count: 0, items: [] });

    const rows = (await query(
      `${PLAN_SELECT} where p.author_id = $1 order by p.start_date desc, p.created_at desc`,
      [authorId],
    )).rows;
    return c.json({ count: rows.length, items: rows });
  });

  // 플랜 상세 — days/items 포함
  v1.get('/plans/:planId', async (c) => {
    const deviceId = deviceIdOf(c);
    if (!deviceId) return c.json({ error: 'missing_deviceId', message: 'deviceId 는 필수입니다.' }, 400);
    const authorId = await findAuthor(deviceId);

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

    const deviceId = str(p.deviceId)
    const authorNm = str(p.authorNm)
    const title = str(p.title)
    const startDate = str(p.startDate)
    const endDate = str(p.endDate)

    if (!deviceId) return c.json({ error: 'missing_deviceId', message: 'deviceId 는 필수입니다.' }, 400)
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

    // 처음 저장하는 기기라면 닉네임이 필요하다(authors.nickname 은 not null).
    const known = (await query<{ id: number }>('select id from authors where device_id = $1', [deviceId])).rows[0]
    if (!known && !authorNm) {
      return c.json({ error: 'missing_authorNm', message: '처음 저장하는 기기입니다. authorNm 을 함께 보내주세요.' }, 400)
    }

    try {
      await withTransaction(async (client) => {
        const author = authorNm
          ? (await client.query<{ id: number }>(
              `insert into authors (device_id, nickname) values ($1, $2)
                 on conflict (device_id) do update set nickname = excluded.nickname
               returning id`, [deviceId, authorNm],
            )).rows[0]
          : (await client.query<{ id: number }>(
              'select id from authors where device_id = $1', [deviceId],
            )).rows[0]
        if (!author) throw new Error('author_upsert_failed')

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
    const deviceId = deviceIdOf(c)
    if (!deviceId) return c.json({ error: 'missing_deviceId', message: 'deviceId 는 필수입니다.' }, 400)

    const authorId = await findAuthor(deviceId)
    // 남의 플랜과 없는 플랜을 구분해 주지 않는다 — 조회와 같은 규칙이다.
    if (authorId == null) return c.json({ error: 'not_found', message: '플랜을 찾을 수 없습니다.' }, 404)

    const result = await query(
      'delete from plans where id = $1 and author_id = $2',
      [c.req.param('planId'), authorId],
    )
    if (result.rowCount === 0) return c.json({ error: 'not_found', message: '플랜을 찾을 수 없습니다.' }, 404)
    return c.body(null, 204)
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
