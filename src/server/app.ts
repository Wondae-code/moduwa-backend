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

  app.route('/v1', v1);

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => {
    console.error('[api] 오류:', err);
    return c.json({ error: 'internal_error' }, 500);
  });
  return app;
}
