// moduwa 관광 데이터 REST API — Hono
//  조회는 전부 읽기 전용. 예외적으로 리뷰(POST /v1/reviews)만 쓰기를 허용한다.
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { config } from '../config';
import { type PartyKind, type RecommendInput, recommend, weights } from './recommend';
import { privacyPage, termsPage } from './legal-pages';
import { pushToAuthor, quote } from './push';
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
      '🔒 PATCH · DELETE /v1/reviews/:reviewId/comments/:commentId  (본인 것만)',
      '🔒 POST /v1/plans/recommend  {region|regionCode, startDate, endDate, party?, themes?, budget?, dayTripOnly?, avoidCrowds?}',
      '🔒 GET /v1/plans',
      '🔒 GET /v1/plans/:planId',
      '🔒 PUT /v1/plans/:planId  {authorNm?, title, startDate, endDate, region?, party?, themes?, budget?, dayTripOnly?, coverImageURL?, days[]}',
      '🔒 DELETE /v1/plans/:planId',
      '🔒 POST /v1/plans/:planId/invites  (소유자 — 초대 코드 발급, 이전 코드 회수)',
      '🔒 DELETE /v1/plans/:planId/invites  (소유자 — 초대 회수)',
      '🔒 POST /v1/plan-invites/accept  {code}',
      '🔒 DELETE /v1/plans/:planId/members/:uuid  (소유자 내보내기 / 본인 나가기)',
      '🔒 GET /v1/saved-places',
      '🔒 PUT /v1/saved-places/:contentId',
      '🔒 DELETE /v1/saved-places/:contentId',
      'GET /v1/posts?mine=&liked=&contentId=&limit=&offset=  (mine·liked 는 🔒)',
      'GET /v1/posts/:postId',
      '🔒 POST /v1/posts  {body, authorNm?, imageURLs?, places?, accessFeatures?}',
      '🔒 PATCH /v1/posts/:postId  {body?, imageURLs?, accessFeatures?, places?}',
      '🔒 DELETE /v1/posts/:postId',
      '🔒 PUT /v1/posts/:postId/like',
      '🔒 DELETE /v1/posts/:postId/like',
      '🔒 PUT /v1/reviews/:reviewId/like',
      '🔒 DELETE /v1/reviews/:reviewId/like',
      'GET /v1/posts/:postId/comments',
      '🔒 POST /v1/posts/:postId/comments  {body, authorNm?}',
      '🔒 PATCH · DELETE /v1/posts/:postId/comments/:commentId  (본인 것만)',
      '🔒 GET · POST /v1/blocks  {uuid}  ·  DELETE /v1/blocks/:uuid  (사용자 차단)',
      '🔒 POST /v1/reports  {targetType, targetId, reason, detail?}'
        + '  (targetType: post · post_comment · review · review_comment)',
      '🔒 POST /v1/reviews/:reviewId/report  {reason, detail?}  (구 경로 — /v1/reports 와 같은 표에 쌓인다)',
      '🔒 POST /v1/devices  {token, platform?, environment, bundleId?}',
      '🔒 DELETE /v1/devices/:token',
      '',
      'POST /v1/auth/google · /v1/auth/apple · /v1/auth/kakao  {idToken, deviceId?, nickname?, accessFeatures?}',
      '',
      'GET /p/:contentId  (장소 공유 대체 페이지 — 인증 불필요)',
      'GET /privacy · /terms  (개인정보 처리방침 · 이용약관 — 인증 불필요)',
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
  // ── 유니버설 링크 기반 (moduwa.app 루트가 이 서버를 가리킨다) ──────────────
  //  ⚠️ 전부 **인증 없이** 연다. iOS 는 앱 설치 시점에 익명으로 AASA 를 받아가고,
  //     초대 대체 페이지는 앱이 없는 사람이 보는 화면이다.
  app.get('/.well-known/apple-app-site-association', (c) => {
    // 비어 있으면 404 — 애플 CDN 이 "연결 없음" 상태의 빈 파일을 캐시하는 것보다 낫다.
    if (config.web.appleAppIds.length === 0) return c.notFound();
    // ⚠️ content-type 은 application/json 이어야 하고 리다이렉트가 없어야 한다(애플 요구사항).
    return c.json({
      // ⚠️ 경로를 추가하면 **애플 CDN 캐시 때문에 이미 설치된 기기는 앱을 다시 받아야** 반영된다.
      //    그래서 새 경로는 앱 배포보다 **먼저** 서버에 올려 둔다(앱 팀 요청).
      applinks: {
        details: [{
          appIDs: config.web.appleAppIds,
          components: [
            { '/': '/i/*' },   // 플랜 초대
            { '/': '/p/*' },   // 장소 공유
          ],
        }],
      },
      webcredentials: { apps: config.web.appleAppIds },
    });
  });

  app.get('/.well-known/assetlinks.json', (c) => {
    if (!config.web.androidPackage || config.web.androidCertSha256.length === 0) return c.notFound();
    return c.json([{
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: config.web.androidPackage,
        sha256_cert_fingerprints: config.web.androidCertSha256,
      },
    }]);
  });

  // 초대 링크의 대체 페이지 — **앱이 설치돼 있으면 이 페이지는 뜨지 않는다**(iOS 가 링크를
  //  가로채 앱을 연다). 여기 도달했다는 것은 앱이 없거나, 카톡 인앱 웹뷰처럼 유니버설 링크가
  //  발동하지 않는 경로로 열었다는 뜻이다. 코드를 크게 보여줘 앱에서 수동 입력할 수 있게 한다.
  app.get('/i/:code', async (c) => {
    // ⚠️ URL 파라미터를 화면에 그대로 되돌리지 않는다(XSS). 엄격히 검증해 통과한 값만 쓴다.
    const raw = (c.req.param('code') ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const valid = /^[A-Z0-9]{8}$/.test(raw);

    let state: 'ok' | 'expired' | 'invalid' = 'invalid';
    if (valid) {
      const row = (await query<{ expired: boolean }>(
        `select (expires_at <= now()) as expired from plan_invites
          where code_hash = $1 and revoked_at is null`,
        [createHash('sha256').update(raw).digest('hex')],
      )).rows[0];
      state = row ? (row.expired ? 'expired' : 'ok') : 'invalid';
    }

    const store = config.web.appStoreUrl;
    const body = state === 'ok'
      ? `<p class="m">여행 플랜에 초대받으셨어요.</p>
         <a class="btn" href="moduwa://i/${raw}">앱에서 열기</a>
         <p class="s">버튼이 동작하지 않으면 모두와 앱의<br><b>플랜 → 초대 코드 입력</b>에 아래 코드를 넣어주세요.</p>
         <div class="code">${raw.slice(0, 4)}-${raw.slice(4)}</div>
         ${store ? `<a class="btn2" href="${store}">앱 받기</a>` : ''}`
      : state === 'expired'
        ? `<p class="m">초대가 만료되었어요.</p>
           <p class="s">초대 코드는 30분 동안만 유효해요.<br>초대한 분에게 새 코드를 요청해주세요.</p>`
        : `<p class="m">유효하지 않은 초대예요.</p>
           <p class="s">링크가 잘못 전달됐을 수 있어요. 초대한 분에게 다시 요청해주세요.</p>`;

    return c.html(`<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>모두와 — 플랜 초대</title>
<style>
  body{margin:0;font-family:-apple-system,'Apple SD Gothic Neo',sans-serif;background:#F7F8F8;color:#1C2B33;
       display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{background:#fff;border-radius:16px;padding:40px 32px;max-width:340px;width:calc(100% - 48px);
        text-align:center;box-shadow:0 2px 16px rgba(28,43,51,.08)}
  .logo{font-weight:700;font-size:15px;color:#0B5F6B;letter-spacing:.02em;margin-bottom:20px}
  .m{font-size:19px;font-weight:700;margin:0 0 10px}
  .s{font-size:14px;line-height:1.7;color:#5B6B73;margin:0 0 20px}
  .code{font-family:ui-monospace,Menlo,monospace;font-size:26px;font-weight:600;letter-spacing:.14em;
        background:#EEF4F5;border-radius:10px;padding:14px 0;margin:0 0 20px;user-select:all}
  .btn{display:inline-block;background:#0B5F6B;color:#fff;text-decoration:none;font-size:15px;
       font-weight:600;padding:12px 28px;border-radius:10px;margin-bottom:20px}
  .btn2{display:inline-block;background:#EEF4F5;color:#0B5F6B;text-decoration:none;font-size:14px;
        font-weight:600;padding:10px 24px;border-radius:10px}
</style></head><body><div class="card"><div class="logo">모두와</div>${body}</div></body></html>`);
  });

  /**
   * 장소 공유 링크의 대체 페이지 — **앱이 설치돼 있으면 이 페이지는 뜨지 않는다**(iOS 가 앱으로
   * 보낸다). 여기 도달했다는 건 앱이 없거나 카톡 인앱 웹뷰로 열었다는 뜻이다(/i/:code 와 같다).
   *
   * ⚠️ **OG 태그가 이 페이지의 핵심이다.** 카톡에서 카드로 보이느냐 파란 글씨로 보이느냐가
   *    여기서 갈린다(앱 팀). 그래서 장소를 못 찾아도 최소한의 OG 는 넣는다.
   *
   * ⚠️ **모든 삽입 값을 이스케이프한다.** 장소 이름에 따옴표가 들어오는 경우가 있어, 속성값에
   *    그대로 넣으면 태그가 깨지고 주입 경로가 된다.
   */
  app.get('/p/:contentId', async (c) => {
    // ⚠️ 파라미터를 화면에 되돌리지 않는다 — 숫자만 통과시킨다(/i/:code 와 같은 규칙).
    const id = c.req.param('contentId') ?? '';
    if (!/^\d+$/.test(id)) return c.notFound();

    const place = (await query<{
      title: string; addr1: string | null; firstimage: string | null; contenttypeid: string | null;
      access_wheelchair: boolean; access_visual: boolean; access_hearing: boolean;
      access_infant: boolean; access_elderly: boolean;
    }>(
      `select title, addr1, firstimage, contenttypeid,
              access_wheelchair, access_visual, access_hearing, access_infant, access_elderly
         from barrier_free where contentid = $1`, [id],
    )).rows[0];

    const store = config.web.appStoreUrl;
    const origin = config.web.origin;
    const url = `${origin}/p/${id}`;

    // ⚠️ **문구의 정본은 앱이다.** 온보딩·프로필·카드·칩에 같은 단어가 박혀 있어, 여기서
    //    다르게 쓰면 같은 장소에 두 이름이 생긴다(앱 팀 요청으로 2026-09-05 맞춤).
    //    순서는 목록 응답의 access 객체와 같다.
    const features = place ? ([
      [place.access_wheelchair, '휠체어 접근'],
      [place.access_visual, '시각 지원'],
      [place.access_hearing, '청각 지원'],
      [place.access_infant, '유아 동반'],
      [place.access_elderly, '고령자 친화'],
    ] as const).filter(([on]) => on).map(([, label]) => label) : [];

    const image = toHttps(place?.firstimage ?? null);
    const ogTitle = place ? `${place.title} — 모두와` : '모두와 — 무장애 여행';
    const ogDesc = place
      ? [place.addr1, features.length ? `무장애: ${features.join(', ')}` : null]
          .filter(Boolean).join(' · ')
      : '앱에서 무장애 여행 정보를 확인해보세요.';

    const body = place
      ? `<p class="m">${esc(place.title)}</p>
         ${place.addr1 ? `<p class="s">${esc(place.addr1)}</p>` : ''}
         ${image ? `<img class="ph" src="${esc(image)}" alt="">` : ''}
         ${features.length
            ? `<div class="tags">${features.map((f) => `<span class="tag">${esc(f)}</span>`).join('')}</div>`
            : '<p class="s">등록된 무장애 정보가 없어요.</p>'}
         <a class="btn" href="moduwa://p/${id}">앱에서 열기</a>
         ${store ? `<a class="btn2" href="${esc(store)}">앱 받기</a>` : ''}
         <p class="src">무장애 정보 출처: 한국관광공사 TourAPI</p>`
      : `<p class="m">찾을 수 없는 장소예요.</p>
         <p class="s">링크가 잘못 전달됐거나 정보가 내려갔을 수 있어요.</p>
         ${store ? `<a class="btn2" href="${esc(store)}">앱 받기</a>` : ''}`;

    return c.html(`<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(ogTitle)}</title>
<meta property="og:type" content="website">
<meta property="og:site_name" content="모두와">
<meta property="og:title" content="${esc(ogTitle)}">
<meta property="og:description" content="${esc(ogDesc)}">
${image ? `<meta property="og:image" content="${esc(image)}">` : ''}
<meta property="og:url" content="${esc(url)}">
<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
<style>
  body{margin:0;font-family:-apple-system,'Apple SD Gothic Neo',sans-serif;background:#F7F8F8;color:#1C2B33;
       display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{background:#fff;border-radius:16px;padding:40px 32px;max-width:340px;width:calc(100% - 48px);
        text-align:center;box-shadow:0 2px 16px rgba(28,43,51,.08)}
  .logo{font-weight:700;font-size:15px;color:#0B5F6B;letter-spacing:.02em;margin-bottom:20px}
  .m{font-size:19px;font-weight:700;margin:0 0 6px;word-break:keep-all}
  .s{font-size:14px;line-height:1.7;color:#5B6B73;margin:0 0 16px;word-break:keep-all}
  .ph{width:100%;height:160px;object-fit:cover;border-radius:12px;margin:0 0 16px;background:#EEF4F5}
  .tags{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin:0 0 20px}
  .tag{background:#EEF4F5;color:#0B5F6B;font-size:13px;font-weight:600;padding:6px 12px;border-radius:999px}
  .btn{display:inline-block;background:#0B5F6B;color:#fff;text-decoration:none;font-size:15px;
       font-weight:600;padding:12px 28px;border-radius:10px;margin-bottom:12px}
  .btn2{display:inline-block;background:#EEF4F5;color:#0B5F6B;text-decoration:none;font-size:14px;
        font-weight:600;padding:10px 24px;border-radius:10px}
  .src{font-size:11px;color:#9AAAB1;margin:16px 0 0}
</style></head><body><div class="card"><div class="logo">모두와</div>${body}</div></body></html>`);
  });

  // 개인정보 처리방침 · 이용약관 — **인증 없이** 연다.
  //  앱스토어가 로그인 없이 접근되는 공개 URL 을 요구한다(legal-pages.ts 상단).
  app.get('/privacy', (c) => c.html(privacyPage()));
  app.get('/terms', (c) => c.html(termsPage()));

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
    // ⚠️ 목록도 이미지를 https 로 올린다. 홈 피드가 이 응답을 쓰므로 여기가 A14 의 주 무대다.
    const items = (rows as Record<string, unknown>[]).map((r) => ({
      ...r, firstimage: toHttps(r.firstimage), firstimage2: toHttps(r.firstimage2),
    }));
    return c.json({ total, limit, offset, count: items.length, sort, items });
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

    // 카카오맵 **장소 상세** 링크. 좌표 링크(map.kakao.com/link/map/...)는 핀만 찍혀서
    //  리뷰·사진·길찾기로 이어지지 않는다. 매칭된 곳은 83%(8,567/10,266)이고, 없으면 null 이라
    //  앱이 좌표 링크로 폴백한다.
    const kakao = (await query<{ place_url: string | null }>(
      `select place_url from kakao_place
        where content_id = $1 and matched and nullif(place_url, '') is not null limit 1`, [id],
    )).rows[0];

    return c.json({
      ...base,
      firstimage: toHttps(base.firstimage),
      firstimage2: toHttps(base.firstimage2),
      kakaoPlaceUrl: toHttps(kakao?.place_url),
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
        imageURL: toHttps(r.firstimage),
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

  /**
   * 외부 URL 을 https 로 올린다.
   *
   * ⚠️ **iOS ATS 가 평문 http 를 막는다.** TourAPI 이미지가 http 3,999 · https 4,237 로 섞여
   *    있어서 절반의 장소에서 사진이 조용히 안 떴다(앱 A14 의 원인). 카카오 place_url 은
   *    39,802건 **전부** http 다.
   *    두 호스트 모두 https 로 200 을 준다(확인함) — 서버에서 올려 보내면 앱이 처리할 일이 없다.
   *    ⚠️ 다른 호스트까지 무조건 바꾸지는 않는다. https 를 지원하지 않는 곳이면 링크가 깨진다.
   */
  const HTTPS_SAFE_HOSTS = /^http:\/\/(tong\.visitkorea\.or\.kr|place\.map\.kakao\.com|.*\.daumcdn\.net)\//;
  const toHttps = (url: unknown): string | null => {
    if (typeof url !== 'string' || !url.trim()) return null;
    const u = url.trim();
    return HTTPS_SAFE_HOSTS.test(u) ? u.replace(/^http:/, 'https:') : u;
  };

  /**
   * HTML 이스케이프 — 서버가 뱉는 페이지에 값을 넣을 때 반드시 거친다.
   *
   * ⚠️ **다섯 글자를 모두 바꾼다.** 텍스트 자리뿐 아니라 속성값(og:title 등)에도 쓰이므로
   *    따옴표 두 종류가 빠지면 태그가 깨지고 주입 경로가 된다 — 장소 이름에 따옴표가 들어오는
   *    경우가 실제로 있다(앱 팀 지적).
   * ⚠️ `&` 를 **가장 먼저** 바꿔야 한다. 나중에 바꾸면 앞서 만든 `&lt;` 의 `&` 를 다시 이스케이프해
   *    `&amp;lt;` 가 된다. URL 의 쿼리스트링에도 `&` 가 들어와 실제로 걸린다.
   */
  const esc = (v: unknown): string =>
    String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

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

    // 검색어를 색인과 **같은 규칙**으로 정규화한다(041 의 생성 컬럼 식과 자소 단위까지 동일).
    //  "경 복궁"·"황리단 길" 이 0건이던 원인이 이 정규화의 부재였다 — ILIKE 는 부분 문자열이
    //  정확히 이어져야 잡는데, 원문끼리 비교하면 띄어쓰기 하나로 어긋난다.
    //  정규화가 %·_ 를 제거하므로 LIKE 이스케이프도 더는 필요 없다.
    const norm = q.toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
    // 기호만 친 검색어는 정규화 후 빈 문자열 — '%%' 로 전체를 돌려주는 대신 솔직하게 0건.
    if (!norm) return c.json({ total: 0, limit, offset, count: 0, sort: null, items: [] });

    const w = await weights();
    const tSim  = w.get('search.jamo_sim_threshold')  ?? 0.4;
    const tWord = w.get('search.jamo_word_threshold') ?? 0.5;
    const mix   = w.get('search.jamo_word_mix')       ?? 0.5;
    const addrW = w.get('search.addr_weight')         ?? 0.6;

    // ── 오타 폴백은 자모 단위다(041 주석의 실측 근거).
    //  음절 트라이그램은 받침 하나 차이("경북궁"→"경복궁")를 못 잡는다 — 한글 음절은 한 글자가
    //  통째로 달라져 3글자 창이 전부 어긋난다. 자모로 풀면 9자 중 1자 차이가 된다.
    //  포함 조건은 두 지표의 OR(느슨하게), 순위는 sim + mix×wsim(오답 분리)이다.
    const wsql = `
      where b.title_norm like '%' || qq.n || '%'
         or b.addr1_norm like '%' || qq.n || '%'
         or similarity(b.title_jamo, qq.j) > ${Number(tSim)}
         or word_similarity(qq.j, b.title_jamo) > ${Number(tWord)}`;

    const total = (await query<{ n: number }>(
      `with qq as (select $1::text as n, hangul_jamo($1) as j)
       select count(*)::int n from barrier_free b, qq ${wsql}`, [norm],
    )).rows[0]!.n;

    const rows = (await query<{
      contentid: string; title: string | null; contenttypeid: string | null;
      addr1: string | null; firstimage: string | null;
      mapx: number | null; mapy: number | null;
      access_wheelchair: boolean; access_visual: boolean; access_hearing: boolean;
      access_infant: boolean; access_elderly: boolean;
    }>(
      `with qq as (select $1::text as n, hangul_jamo($1) as j)
       select b.contentid, b.title, b.contenttypeid, b.addr1, b.firstimage, b.mapx, b.mapy,
              b.access_wheelchair, b.access_visual, b.access_hearing, b.access_infant, b.access_elderly
         from barrier_free b, qq ${wsql}
        order by
          -- 계층이 먼저다: 정확 > 접두 > 부분 > 주소 > 오타 추정. 오타 폴백이 정확 일치 위로
          --  올라오면 안 되고, 유사도 점수는 같은 계층 안의 순서만 정한다.
          case
            when b.title_norm = qq.n                    then 0
            when b.title_norm like qq.n || '%'          then 1
            when b.title_norm like '%' || qq.n || '%'   then 2
            when b.addr1_norm like '%' || qq.n || '%'   then 3
            else 4
          end,
          greatest(
            similarity(b.title_jamo, qq.j) + ${Number(mix)} * word_similarity(qq.j, b.title_jamo),
            ${Number(addrW)} * similarity(b.addr1_norm, qq.n)
          ) desc,
          b.has_image desc, b.has_access desc, char_length(b.title), b.title, b.contentid
        limit ${limit} offset ${offset}`, [norm],
    )).rows;

    const items = rows.map((r) => ({
      contentid: r.contentid,
      title: r.title,
      contenttypeid: r.contenttypeid,
      category: (r.contenttypeid && CATEGORY_LABELS[r.contenttypeid]) || null,
      region: shortRegion(r.addr1),
      firstimage: toHttps(r.firstimage),
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

  // ── 차단 필터(048) — 목록마다 끼운다. 라우트만 열고 목록을 그대로 두면
  //  심사에서 "차단이 동작하지 않는다" 로 잡힌다.
  /**
   * "이 행의 작성자를 보는 사람이 차단했나" 를 묻는 조건. 목록 쿼리의 where 에 붙인다.
   *
   * 비로그인이면 viewer 파라미터가 null 이라 not exists 가 늘 참이 되어 아무것도 걸러지지
   * 않는다 — 차단은 로그인한 사람의 설정이므로 그것이 맞다.
   *
   * @param authorCol 걸러낼 작성자 컬럼(예: 'p.author_id')
   * @param viewerParam 보는 사람의 파라미터 번호
   */
  const blockFilter = (authorCol: string, viewerParam: number) =>
    `not exists (select 1 from blocks b
                  where b.blocker_id = $${viewerParam} and b.blocked_id = ${authorCol})`

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
           a.avatar_url as author_avatar,
           a.uuid as author_uuid,
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
    author_avatar: string | null;
  };

  // 기존 응답 필드는 그대로 두고(iOS 라이브 사용 중) 작성자 프로필만 authorInfo 로 덧붙인다.
  //  · author  : 레거시 문자열(닉네임). 제거하면 iOS ReviewDTO 디코딩이 깨진다.
  //  · authorInfo: {nickname, reviewCount, level} — 시안의 "닉네임 / Level N / N개의 리뷰"용.
  const shapeReview = (row: ReviewRow) => {
    const {
      author_nickname: nickname, author_review_count: count, author_avatar: avatar,
      author_uuid: uuid, ...rest
    } = row;
    const reviewCount = count ?? 0;
    return {
      ...rest,
      authorInfo: {
        nickname: nickname ?? row.author, reviewCount, level: levelFor(reviewCount),
        // 차단·신고가 가리킬 식별자(048). authors.id 는 넣지 않는다 — uuid 가 외부 노출용이다.
        //  레거시 행(author_id 없음)은 null 이라 앱이 차단 메뉴를 감춰야 한다.
        uuid: uuid ?? null,
        // 042. author_id 가 없는 레거시 행은 조인이 안 되어 null 이다 — 앱이 이니셜 원을 그린다.
        //  toHttps 로 감싸는 이유: 저장 시 https 만 받지만, 나중에 CDN 이 붙어 호스트가 바뀌어도
        //  같은 정규화를 타게 해 둔다(A14 의 교훈 — 섞인 스킴은 조용히 안 보인다).
        avatarUrl: toHttps(avatar),
      },
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
    // ⚠️ 보는 사람을 **$1 로 앞에 둔다.** 차단 필터가 생기면서 count 도 viewer 가 필요해졌다 —
    //  예전처럼 SELECT 에만 주면 total 은 차단한 사람의 후기를 세고 items 는 빼서, 페이지마다
    //  개수가 어긋나고 마지막 페이지가 비어 보인다.
    const filters: unknown[] = [authorOf(c)];
    const viewerParam = filters.length;
    where.push(blockFilter('r.author_id', viewerParam));
    const contentId = c.req.query('contentId');
    if (contentId) { filters.push(contentId); where.push(`r.content_id = $${filters.length}`); }
    // 시안의 "사진/영상 후기만 보기". image_urls 가 null 인 행도 있어 coalesce 로 감싼다.
    if (c.req.query('hasImage') === 'true') where.push('coalesce(array_length(r.image_urls, 1), 0) > 0');
    const wsql = where.length ? `where ${where.join(' and ')}` : '';

    const total = (await query<{ n: number }>(
      `select count(*)::int n from reviews r ${wsql}`, filters)).rows[0]!.n;
    const rows = (await query<ReviewRow>(
      `${reviewSelect(viewerParam)} ${wsql} order by ${order} limit ${limit} offset ${offset}`, filters,
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
    // 차단한 사람의 후기는 평균·개수에서도 뺀다 — 목록에서 사라진 후기가 개수에는 남아
    //  "후기 3" 인데 두 개만 보이는 상태를 만들지 않는다.
    const viewerId = authorOf(c);
    const row = (await query<{ review_count: number; rated_count: number; avg_rating: number | null }>(
      `select count(*)::int          as review_count,
              count(rating)::int     as rated_count,
              round(avg(rating)::numeric, 1)::float8 as avg_rating
         from reviews r where r.content_id = $1 and ${blockFilter('r.author_id', 2)}`,
      [contentId, viewerId],
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
        where r.content_id = $1 and ${blockFilter('r.author_id', 2)}
        group by d.code, d.label, d.short_label, d.icon, d.sort_order
        order by count desc, d.sort_order`, [contentId, viewerId],
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

  /// $VIEWER 는 보는 사람의 author_id(없으면 null) — 게시글 댓글과 같은 규칙이다.
  ///  ⚠️ coalesce 가 필요하다. 비로그인이면 "author_id = null" 이 false 가 아니라 NULL 이다.
  const COMMENT_SELECT = `
    select c.id, c.body,
           coalesce(c.author_id = $VIEWER, false) as "isMine",
           to_char(c.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "createdAt",
           a.nickname as author, a.avatar_url as author_avatar, a.uuid as author_uuid,
           (select count(*)::int from reviews r2 where r2.author_id = c.author_id) as author_review_count
      from review_comments c
      join authors a on a.id = c.author_id`;

  /** 보는 사람 자리를 실제 파라미터 번호로 바꿔 준다(replaceAll — 늘어나도 안전하다). */
  const commentSelect = (viewerParam: number) =>
    COMMENT_SELECT.replaceAll('$VIEWER', `$${viewerParam}`);

  type CommentRow = Record<string, unknown> & {
    author: string; author_review_count: number | null; author_avatar: string | null;
  };

  const shapeComment = (row: CommentRow) => {
    const { author_review_count: count, author_avatar: avatar, author_uuid: uuid, ...rest } = row;
    const reviewCount = count ?? 0;
    return {
      ...rest,
      authorInfo: {
        nickname: row.author, reviewCount, level: levelFor(reviewCount),
        avatarUrl: toHttps(avatar),
        uuid: (uuid as string | null) ?? null,
      },
    };
  };

  /** 경로의 reviewId 를 정수로. 형식이 틀리면 null (404 로 응답한다). */
  const parseReviewId = (raw: string): number | null => {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  };

  /**
   * 경로의 댓글 id 를 정수로. 형식이 틀리면 null (404). 후기 댓글·게시글 댓글이 함께 쓴다.
   *
   * ⚠️ 문자열로 돌려준다 — bigserial 은 자바스크립트 정수 범위를 넘을 수 있고, Number 로
   *    바꾸면 큰 id 가 조용히 어긋난다. 형식만 확인하고 값은 그대로 파라미터로 넘긴다.
   */
  const parseCommentId = (raw: string | undefined): string | null =>
    raw && /^[0-9]{1,18}$/.test(raw) ? raw : null;

  // 댓글 목록 — 대화 순서(오래된 순). 리뷰가 없으면 404.
  v1.get('/reviews/:reviewId/comments', async (c) => {
    const reviewId = parseReviewId(c.req.param('reviewId'));
    if (reviewId == null) return c.json({ error: 'not_found', message: '리뷰를 찾을 수 없습니다.' }, 404);
    const { limit, offset } = paging(c);

    const exists = (await query<{ id: number }>('select id from reviews where id = $1', [reviewId])).rows[0];
    if (!exists) return c.json({ error: 'not_found', message: '리뷰를 찾을 수 없습니다.' }, 404);

    // 보는 사람 = 세션의 계정. 목록은 공개라 비로그인이면 null 이고 isMine 은 false 다.
    const viewerId = authorOf(c);
    // total 도 같은 조건으로 센다 — 어긋나면 페이지 개수가 맞지 않는다.
    const total = (await query<{ n: number }>(
      `select count(*)::int n from review_comments c
        where c.review_id = $1 and ${blockFilter('c.author_id', 2)}`, [reviewId, viewerId],
    )).rows[0]!.n;
    const rows = (await query<CommentRow>(
      `${commentSelect(2)} where c.review_id = $1 and ${blockFilter('c.author_id', 2)}
        order by c.created_at, c.id limit ${limit} offset ${offset}`,
      [reviewId, viewerId],
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

    const review = (await query<{ id: number; blocked: boolean }>(
      `select r.id,
              exists (select 1 from blocks b
                       where b.blocker_id = r.author_id and b.blocked_id = $2) as blocked
         from reviews r where r.id = $1`, [reviewId, gate.authorId])).rows[0];
    if (!review) return c.json({ error: 'not_found', message: '리뷰를 찾을 수 없습니다.' }, 404);
    // 쓰기 차단 — 게시글 댓글과 같은 규칙이다(048).
    if (review.blocked) {
      return c.json({ error: 'blocked_by_author', message: '이 후기에는 댓글을 쓸 수 없습니다.' }, 403);
    }

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

    const row = (await query<CommentRow>(
      `${commentSelect(2)} where c.id = $1`, [newId, gate.authorId])).rows[0]!;
    return c.json(shapeComment(row), 201);
  });

  /**
   * 후기 댓글 수정 · 삭제 — 게시글 댓글과 같은 규칙이다(본인 것만, 나머지는 전부 404).
   */
  v1.patch('/reviews/:reviewId/comments/:commentId', async (c) => {
    const gate = requireAuth(c);
    if (gate instanceof Response) return gate;
    const reviewId = parseReviewId(c.req.param('reviewId'));
    const commentId = parseCommentId(c.req.param('commentId'));
    if (reviewId == null || commentId == null) {
      return c.json({ error: 'not_found', message: '댓글을 찾을 수 없습니다.' }, 404);
    }

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json', message: 'JSON 본문을 파싱할 수 없습니다.' }, 400);
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return c.json({ error: 'invalid_body', message: 'JSON 객체를 보내주세요.' }, 400);
    }
    const raw = (payload as Record<string, unknown>).body;
    const bodyText = typeof raw === 'string' ? raw.trim() : '';
    if (!bodyText) return c.json({ error: 'missing_body', message: '댓글 내용은 비어 있을 수 없습니다.' }, 400);
    if (bodyText.length > MAX_COMMENT_LEN) {
      return c.json({ error: 'invalid_body', message: `댓글은 ${MAX_COMMENT_LEN}자 이하여야 합니다.` }, 400);
    }

    const updated = await query(
      `update review_comments set body = $1
        where id = $2 and review_id = $3 and author_id = $4`,
      [bodyText, commentId, reviewId, gate.authorId]);
    if (updated.rowCount === 0) {
      return c.json({ error: 'not_found', message: '댓글을 찾을 수 없습니다.' }, 404);
    }

    const row = (await query<CommentRow>(
      `${commentSelect(2)} where c.id = $1`, [commentId, gate.authorId])).rows[0]!;
    return c.json(shapeComment(row));
  });

  /**
   * 하드 삭제다 — 대댓글이 없어 남길 맥락이 없다(앱 팀 확인).
   *
   * ⚠️ **reviews.comment_count 를 같은 트랜잭션에서 줄인다.** 작성 때 +1 하고 있어서, 삭제만
   *    하면 후기 카드의 댓글 수가 실제보다 많아진다(앱 팀 지적). 목록 응답의 commentCount 와
   *    '추천순' 정렬이 이 카운터를 읽는다.
   * ⚠️ greatest(…, 0) 으로 막는다. 카운터가 어긋난 과거 데이터에서 음수가 되면, 화면에
   *    "-1개" 가 뜨고 추천순 정렬이 그 후기를 맨 뒤로 밀어 버린다.
   */
  v1.delete('/reviews/:reviewId/comments/:commentId', async (c) => {
    const gate = requireAuth(c);
    if (gate instanceof Response) return gate;
    const reviewId = parseReviewId(c.req.param('reviewId'));
    const commentId = parseCommentId(c.req.param('commentId'));
    if (reviewId == null || commentId == null) {
      return c.json({ error: 'not_found', message: '댓글을 찾을 수 없습니다.' }, 404);
    }

    const removed = await withTransaction(async (client) => {
      const del = await client.query(
        'delete from review_comments where id = $1 and review_id = $2 and author_id = $3',
        [commentId, reviewId, gate.authorId]);
      if (del.rowCount === 0) return false;
      await client.query(
        'update reviews set comment_count = greatest(comment_count - 1, 0) where id = $1',
        [reviewId]);
      return true;
    });
    if (!removed) return c.json({ error: 'not_found', message: '댓글을 찾을 수 없습니다.' }, 404);
    return c.body(null, 204);
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

  /**
   * 이 사람이 이 플랜에서 무엇인가. 소유자는 plans.author_id, 편집자는 plan_members 에 있다.
   * 소유자를 멤버 테이블에 넣지 않는 이유: 두 곳에 있으면 권한 계산이 두 갈래가 된다(040).
   */
  const planRole = async (planId: string, authorId: number): Promise<'owner' | 'editor' | null> => {
    const row = (await query<{ role: string }>(
      `select case when p.author_id = $2 then 'owner'
                   when m.author_id is not null then 'editor' end as role
         from plans p left join plan_members m on m.plan_id = p.id and m.author_id = $2
        where p.id = $1`,
      [planId, authorId],
    )).rows[0];
    return (row?.role as 'owner' | 'editor') ?? null;
  };

  const PLAN_SELECT = `
    select p.id, p.title,
           to_char(p.start_date, 'YYYY-MM-DD') as "startDate",
           to_char(p.end_date, 'YYYY-MM-DD')   as "endDate",
           p.region, p.party, p.cover_image_url as "coverImageURL", p.version,
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
              i.image_url, i.latitude, i.longitude,
              -- 무장애 조사를 받은 곳인가. **저장하지 않고 조회 시점에 도출한다.**
              --  정의 자체가 "barrier_free 에 있는가" 이므로 컬럼에 굳힐 이유가 없고,
              --  굳히면 두 가지가 나빠진다 —
              --   ① 이미 저장된 플랜은 값이 없어 배지를 그릴 수 없다(백필해도 결국 이 식이다)
              --   ② 관광공사가 나중에 그 장소를 조사하면 저장값이 낡는다. "정보 없음" 이
              --      영구히 박힌다.
              --  ⚠️ false 는 "접근 불가" 가 아니라 "모른다" 다(recommend.ts hasAccessInfo 주석).
              (i.content_id is not null
               and exists (select 1 from barrier_free b where b.contentid = i.content_id)
              ) as has_access_info
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
                hasAccessInfo: r.has_access_info,
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

    // 내 소유 + 초대받은 플랜. myRole 로 앱이 "함께하는 플랜" 을 구분해 그린다.
    const rows = (await query<Record<string, unknown>>(
      `${PLAN_SELECT}
        where p.author_id = $1
           or exists (select 1 from plan_members m where m.plan_id = p.id and m.author_id = $1)
        order by p.start_date desc, p.created_at desc`,
      [authorId],
    )).rows;
    const mine = new Set((await query<{ id: string }>(
      'select id from plans where author_id = $1', [authorId],
    )).rows.map((r) => r.id));

    const summaries = await loadSummaries(rows.map((r) => r.id as string));
    const items = rows.map((r) => ({
      ...r,
      myRole: mine.has(r.id as string) ? 'owner' : 'editor',
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

    const planId = c.req.param('planId');
    const role = await planRole(planId, authorId);
    // 남의 플랜과 없는 플랜을 구분해 주지 않는다 — 존재 여부가 새어 나갈 이유가 없다.
    if (!role) return c.json({ error: 'not_found', message: '플랜을 찾을 수 없습니다.' }, 404);

    const plan = (await query<Record<string, unknown>>(
      `${PLAN_SELECT} where p.id = $1`, [planId],
    )).rows[0]!;
    // 멤버 목록 — 소유자가 먼저. uuid 만 노출한다(authors.id 는 응답에 넣지 않는 기존 규칙).
    const members = (await query<{ uuid: string; nickname: string; role: string }>(
      `select a.uuid, a.nickname, 'owner' as role
         from plans p join authors a on a.id = p.author_id where p.id = $1
       union all
       select a.uuid, a.nickname, m.role
         from plan_members m join authors a on a.id = m.author_id
        where m.plan_id = $1
        order by role desc`,
      [planId],
    )).rows;

    return c.json({ ...plan, myRole: role, members, days: await loadDays(planId) });
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
      // 시안 4/6 "덜 붐볐으면 좋겠어요" — 혼잡일 회피 세기를 키운다.
      avoidCrowds: p.avoidCrowds === true,
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
    // 낙관적 잠금 토큰. 조회 응답의 version 을 그대로 되돌려 보낸다.
    let bodyVersion: number | null = null
    if (p.version !== undefined) {
      if (typeof p.version !== 'number' || !Number.isInteger(p.version) || p.version < 1) {
        return c.json({ error: 'invalid_version', message: 'version 은 1 이상의 정수여야 합니다.' }, 400)
      }
      bodyVersion = p.version
    }
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

        // 이미 있는 플랜인지, 있다면 내가 손댈 수 있는지 먼저 확정한다.
        //  for update 로 잠근다 — 두 멤버가 동시에 저장하면 한쪽이 여기서 기다렸다가
        //  올라간 version 을 보고 아래에서 409 로 떨어진다. 잠그지 않으면 둘 다 통과한다.
        const existing = (await client.query<{ author_id: number; version: number }>(
          'select author_id, version from plans where id = $1 for update', [planId],
        )).rows[0]

        if (existing) {
          const isOwner = Number(existing.author_id) === author.id
          if (!isOwner) {
            const member = await client.query(
              'select 1 from plan_members where plan_id = $1 and author_id = $2',
              [planId, author.id],
            )
            if (member.rowCount === 0) throw new Error('forbidden')
          }

          // ── 낙관적 잠금. 본문을 통째로 교체하는 저장이라, 버전 검사가 없으면
          //    늦게 저장한 멤버가 먼저 저장한 멤버의 작업을 소리 없이 되돌린다(040).
          if (bodyVersion != null) {
            if (bodyVersion !== existing.version) throw new Error('version_conflict')
          } else {
            // 버전 없는 저장은 구버전 앱이다. 혼자 쓰는 플랜은 지금처럼 통과시키고(호환),
            // **공유 플랜만** 막는다 — 공유에 참여하려면 어차피 새 앱이 필요하므로,
            // 구버전 앱이 공유 플랜을 덮어쓸 수 있는 조합 자체가 생기지 않게 한다.
            const shared = await client.query(
              'select 1 from plan_members where plan_id = $1 limit 1', [planId],
            )
            if (shared.rowCount) throw new Error('version_required')
          }

          await client.query(
            `update plans
                set title = $2, start_date = $3, end_date = $4, region = $5,
                    party = coalesce($6::jsonb, '{}'::jsonb), cover_image_url = $7,
                    themes = $8, budget = $9, day_trip_only = $10,
                    version = version + 1, updated_at = now()
              where id = $1`,
            [planId, title, startDate, endDate, str(p.region) || null,
             JSON.stringify(p.party ?? {}), str(p.coverImageURL) || null,
             themes, budget, dayTripOnly],
          )
        } else {
          await client.query(
            `insert into plans (id, author_id, title, start_date, end_date, region, party,
                                cover_image_url, themes, budget, day_trip_only)
             values ($1, $2, $3, $4, $5, $6, coalesce($7::jsonb, '{}'::jsonb), $8, $9, $10, $11)`,
            [planId, author.id, title, startDate, endDate,
             str(p.region) || null, JSON.stringify(p.party ?? {}), str(p.coverImageURL) || null,
             themes, budget, dayTripOnly],
          )
        }

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
        return c.json({ error: 'forbidden', message: '이 플랜을 편집할 권한이 없습니다.' }, 403)
      }
      if (reason === 'version_required') {
        return c.json({
          error: 'version_required',
          message: '함께 쓰는 플랜은 최신 앱에서만 저장할 수 있습니다.',
        }, 400)
      }
      if (reason === 'version_conflict') {
        // 최신본을 함께 준다 — 앱이 "다른 멤버가 방금 수정했어요" 안내 후 이걸로 갈아끼운다.
        //  다시 GET 을 부르게 하면 그 사이 또 바뀔 수 있고, 왕복도 한 번 늘어난다.
        const latest = (await query<Record<string, unknown>>(`${PLAN_SELECT} where p.id = $1`, [planId])).rows[0]
        return c.json({
          error: 'version_conflict',
          message: '다른 멤버가 방금 이 플랜을 수정했어요. 최신 내용을 확인한 뒤 다시 저장해주세요.',
          latest: latest ? { ...latest, days: await loadDays(planId) } : null,
        }, 409)
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

    const planId = c.req.param('planId')
    const result = await query(
      'delete from plans where id = $1 and author_id = $2',
      [planId, authorId],
    )
    if (result.rowCount === 0) {
      // 편집자에게는 404 대신 403 — 멤버는 플랜의 존재를 이미 알고 있으므로 숨길 것이 없고,
      //  "없다" 고 하면 앱이 목록에서 지워 버리는 잘못된 처리를 유도한다.
      const role = await planRole(planId, authorId)
      if (role === 'editor') {
        return c.json({ error: 'owner_only', message: '플랜 삭제는 소유자만 할 수 있습니다.' }, 403)
      }
      return c.json({ error: 'not_found', message: '플랜을 찾을 수 없습니다.' }, 404)
    }
    return c.body(null, 204)
  })

  // ── 플랜 공동 편집: 초대 · 멤버 ─────────────────────────────────────────────

  // 초대 코드 발급 — 소유자만. 새로 만들면 **이전 활성 코드는 회수된다**(플랜당 활성 코드
  //  하나). "링크 회수" 를 별도 화면 없이 재발급 한 번으로 해결하려는 것이다.
  v1.post('/plans/:planId/invites', async (c) => {
    const gate = requireAuth(c)
    if (gate instanceof Response) return gate
    const planId = c.req.param('planId')

    const role = await planRole(planId, gate.authorId)
    if (!role) return c.json({ error: 'not_found', message: '플랜을 찾을 수 없습니다.' }, 404)
    if (role !== 'owner') {
      return c.json({ error: 'owner_only', message: '초대는 소유자만 할 수 있습니다.' }, 403)
    }

    // 8자, 헷갈리는 글자(0/O·1/I/L) 제외 — 대체 페이지에서 수동 입력할 수 있어야 한다.
    //  공간 31^8 ≈ 8.5e11 에 30분 만료·해시 저장이라 무차별 대입은 성립하지 않는다.
    const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
    const code = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')

    const expires = (await withTransaction(async (client) => {
      await client.query(
        'update plan_invites set revoked_at = now() where plan_id = $1 and revoked_at is null',
        [planId],
      )
      return (await client.query<{ expires_at: Date }>(
        `insert into plan_invites (plan_id, code_hash, created_by, expires_at)
         values ($1, $2, $3, now() + make_interval(mins => $4))
         returning expires_at`,
        [planId, createHash('sha256').update(code).digest('hex'), gate.authorId, config.plans.inviteMinutes],
      )).rows[0]!.expires_at
    }))

    return c.json({
      code,
      // 유니버설 링크. 앱이 있으면 바로 앱이 열리고, 없으면 /i/:code 대체 페이지가 받는다.
      inviteUrl: `${config.web.origin}/i/${code}`,
      expiresAt: expires.toISOString(),
      expiresInMinutes: config.plans.inviteMinutes,
    }, 201)
  })

  // 초대 회수 — 재발급 없이 링크만 죽이고 싶을 때.
  v1.delete('/plans/:planId/invites', async (c) => {
    const gate = requireAuth(c)
    if (gate instanceof Response) return gate
    const planId = c.req.param('planId')

    const role = await planRole(planId, gate.authorId)
    if (!role) return c.json({ error: 'not_found', message: '플랜을 찾을 수 없습니다.' }, 404)
    if (role !== 'owner') {
      return c.json({ error: 'owner_only', message: '초대 관리는 소유자만 할 수 있습니다.' }, 403)
    }
    await query('update plan_invites set revoked_at = now() where plan_id = $1 and revoked_at is null', [planId])
    return c.body(null, 204)
  })

  // 초대 수락 — 코드를 소비하지 않는다(단톡방 하나로 여럿이 들어오는 것이 정상 시나리오).
  //  만료·회수·정원이 통제 장치다.
  v1.post('/plan-invites/accept', async (c) => {
    const gate = requireAuth(c)
    if (gate instanceof Response) return gate

    let payload: unknown
    try { payload = await c.req.json() } catch {
      return c.json({ error: 'invalid_json', message: 'JSON 본문을 파싱할 수 없습니다.' }, 400)
    }
    const raw = typeof (payload as Record<string, unknown>)?.code === 'string'
      ? ((payload as Record<string, unknown>).code as string) : ''
    // 대체 페이지가 WKQ3-M8DZ 처럼 하이픈을 넣어 보여주므로 구분자·소문자를 관대하게 받는다.
    const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (!/^[A-Z0-9]{8}$/.test(code)) {
      return c.json({ error: 'invalid_code', message: '초대 코드가 올바르지 않습니다.' }, 400)
    }

    const invite = (await query<{ plan_id: string; owner_id: number; expired: boolean; title: string }>(
      `select i.plan_id, p.author_id as owner_id, (i.expires_at <= now()) as expired, p.title
         from plan_invites i join plans p on p.id = i.plan_id
        where i.code_hash = $1 and i.revoked_at is null`,
      [createHash('sha256').update(code).digest('hex')],
    )).rows[0]
    if (!invite) return c.json({ error: 'invalid_code', message: '초대 코드가 올바르지 않습니다.' }, 400)
    if (invite.expired) {
      return c.json({
        error: 'invite_expired',
        message: '초대가 만료되었어요. 초대한 분에게 새 코드를 요청해주세요.',
      }, 400)
    }

    const planId = invite.plan_id
    if (Number(invite.owner_id) === gate.authorId) {
      // 소유자가 자기 링크를 누른 경우 — 에러가 아니라 "이미 내 플랜" 이다.
      return c.json({ planId, title: invite.title, myRole: 'owner', alreadyMember: true })
    }

    // 이번 요청으로 **새로 들어왔는지**. 이미 멤버였다면 알림을 보내지 않고(초대 링크를 두 번
    //  열면 두 번 울린다) 응답의 alreadyMember 도 true 여야 한다.
    let joinedNow = false
    try {
      joinedNow = await withTransaction(async (client) => {
        // 정원 검사와 삽입을 한 트랜잭션에 — 나눠 두면 동시 수락이 정원을 넘는다.
        const n = (await client.query<{ n: number }>(
          'select count(*)::int as n from plan_members where plan_id = $1', [planId],
        )).rows[0]!.n
        // 소유자 1 + 멤버 n. 이미 멤버인 사람의 재수락은 정원과 무관하게 통과시켜야 하므로
        // insert 결과로 판단한다.
        const ins = await client.query(
          `insert into plan_members (plan_id, author_id) values ($1, $2)
             on conflict (plan_id, author_id) do nothing`,
          [planId, gate.authorId],
        )
        if (ins.rowCount === 1 && n + 1 >= config.plans.memberCap) throw new Error('member_limit')
        return ins.rowCount === 1
      })
    } catch (error) {
      if (error instanceof Error && error.message === 'member_limit') {
        return c.json({
          error: 'member_limit',
          message: `플랜 인원이 가득 찼어요 (최대 ${config.plans.memberCap}명).`,
        }, 409)
      }
      throw error
    }

    // 이미 멤버였으면 알림 없이 끝낸다 — 초대 링크를 두 번 열어도 두 번 울리지 않는다.
    if (!joinedNow) {
      return c.json({ planId, title: invite.title, myRole: 'editor', alreadyMember: true })
    }

    // 소유자 + 기존 멤버에게 알린다(신규 합류만).
    const joined = (await query<{ nickname: string }>(
      'select nickname from authors where id = $1', [gate.authorId],
    )).rows[0]?.nickname ?? '새 멤버'
    const targets = (await query<{ id: number }>(
      `select author_id as id from plan_members where plan_id = $1 and author_id <> $2
       union
       select author_id from plans where id = $1 and author_id <> $2`,
      [planId, gate.authorId],
    )).rows
    for (const t of targets) {
      await pushToAuthor(Number(t.id), {
        title: '모두와',
        body: `${joined}님이 '${quote(invite.title, 20)}'에 합류했어요`,
        data: { type: 'plan_member_joined', planId },
        threadId: `plan:${planId}`,
      })
    }

    return c.json({ planId, title: invite.title, myRole: 'editor', alreadyMember: false })
  })

  // 멤버 내보내기 / 나가기. 소유자는 아무나, 편집자는 자기 자신만 지울 수 있다.
  v1.delete('/plans/:planId/members/:uuid', async (c) => {
    const gate = requireAuth(c)
    if (gate instanceof Response) return gate
    const planId = c.req.param('planId')
    const targetUuid = c.req.param('uuid')

    const role = await planRole(planId, gate.authorId)
    if (!role) return c.json({ error: 'not_found', message: '플랜을 찾을 수 없습니다.' }, 404)

    const target = (await query<{ id: number }>(
      'select id from authors where uuid = $1', [targetUuid],
    )).rows[0]
    if (!target) return c.json({ error: 'not_found', message: '멤버를 찾을 수 없습니다.' }, 404)

    if (role === 'editor' && Number(target.id) !== gate.authorId) {
      return c.json({ error: 'owner_only', message: '다른 멤버는 소유자만 내보낼 수 있습니다.' }, 403)
    }
    // 소유자 자신은 이 경로로 못 나간다 — 소유자가 빠지면 플랜이 주인 없는 상태가 된다.
    //  소유자가 정리하고 싶으면 플랜 삭제다(소유권 이전은 v2).
    if (role === 'owner' && Number(target.id) === gate.authorId) {
      return c.json({ error: 'owner_cannot_leave', message: '소유자는 나갈 수 없습니다. 플랜을 삭제해주세요.' }, 400)
    }

    const del = await query(
      'delete from plan_members where plan_id = $1 and author_id = $2', [planId, target.id],
    )
    if (del.rowCount === 0) return c.json({ error: 'not_found', message: '멤버를 찾을 수 없습니다.' }, 404)
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
  /**
   * 경로의 postId 를 uuid 로. 형식이 틀리면 null (404 로 응답한다).
   *
   * ⚠️ 이 가드가 없으면 `/v1/posts/abc` 가 **500** 이 된다 — Postgres 가 'abc' 를 uuid 로
   *    바꾸다 실패하기 때문이다. 형식이 틀린 id 는 "없는 글" 이고, 없는 글은 404 다.
   *    앱이 "404 하나로 분기" 할 수 있어야 한다(앱 팀 요청).
   */
  const parsePostId = (raw: string | undefined): string | null =>
    raw && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(raw)
      ? raw : null

  const postNotFound = { error: 'not_found', message: '게시글을 찾을 수 없습니다.' } as const
  const commentNotFound = { error: 'not_found', message: '댓글을 찾을 수 없습니다.' } as const

  const MAX_POST_PLACES = 20
  const MAX_POST_IMAGES = 5

  /** 목록·단건 공통 select. 붙인 장소는 별도 쿼리로 모아 붙인다(N+1 회피). */
  /// $1 은 **보는 사람의 author_id**(없으면 null) — "내가 좋아요를 눌렀나"와 "내 글인가"를
  ///  함께 준다. 숫자만 주면 버튼이 눌린 상태를, 작성자 닉네임만 주면 수정·삭제 메뉴를
  ///  띄울지를 클라이언트가 판단할 수 없다(앱 팀 요청).
  const POST_SELECT = `
    select p.id, p.body, p.image_urls as "imageURLs",
           p.access_features as "accessFeatures",
           a.nickname as author, a.avatar_url as author_avatar, a.uuid as author_uuid,
           (select count(*)::int from post_likes pl where pl.post_id = p.id) as "likeCount",
           (select count(*)::int from post_comments pc where pc.post_id = p.id) as "commentCount",
           exists (
             select 1 from post_likes pl
              where pl.post_id = p.id and pl.author_id = $VIEWER
           ) as "likedByMe",
           -- ⚠️ coalesce 가 필요하다. 비로그인이면 $VIEWER 가 null 이고, SQL 에서
           --  "author_id = null" 은 false 가 아니라 **NULL** 이다. 그대로 두면 isMine 이
           --  false 가 아니라 null 로 나가서, 앱이 비로그인 상태를 판정할 수 없다.
           coalesce(p.author_id = $VIEWER, false) as "isMine",
           to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "createdAt",
           to_char(p.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "updatedAt"
      from posts p
      join authors a on a.id = p.author_id`

  /**
   * 보는 사람 자리를 실제 파라미터 번호로 바꿔 준다.
   *
   * ⚠️ **replaceAll 이어야 한다.** $VIEWER 는 한 번이 아니다(likedByMe · isMine). replace 로
   *    두면 뒤쪽이 그대로 남아 Postgres 가 "$VIEWER" 를 문법 오류로 거절한다.
   */
  const postSelect = (viewerParam: number) =>
    POST_SELECT.replaceAll('$VIEWER', `$${viewerParam}`)

  /**
   * 게시글 한 건에 작성자 프로필을 덧붙인다(042).
   *
   * ⚠️ **기존 `author` 문자열은 그대로 둔다** — iOS 가 라이브로 쓰고 있어 제거하면 디코딩이
   *    깨진다. 후기(shapeReview)가 authorInfo 로 덧붙인 것과 같은 패턴이라 앱이 파서를
   *    공유할 수 있다. reviewCount·level 은 게시글 화면에 쓰이지 않아 넣지 않는다(앱 팀 확인).
   */
  const shapePost = (row: Record<string, unknown>) => {
    const { author_avatar: avatar, author_uuid: uuid, ...rest } = row as {
      author_avatar?: string | null; author_uuid?: string | null
    } & Record<string, unknown>
    return {
      ...rest,
      authorInfo: {
        nickname: rest.author as string, avatarUrl: toHttps(avatar ?? null),
        // 차단·신고가 가리킬 식별자(048). 닉네임으로 차단하면 동명이인이 함께 차단된다.
        uuid: uuid ?? null,
      },
    }
  }

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
    // 차단한 사람의 글은 홈·저장·장소별 어디에서도 보이지 않는다(048).
    conditions.push(blockFilter('p.author_id', 1))
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
    const items = rows.map((r) => ({ ...shapePost(r), places: places.get(r.id as string) ?? [] }))
    return c.json({ count: items.length, limit, offset, items })
  })

  v1.get('/posts/:postId', async (c) => {
    const postId = parsePostId(c.req.param('postId'))
    if (postId == null) return c.json(postNotFound, 404)
    // 보는 사람 = 세션의 계정. 비로그인이면 null 이고 likedByMe 는 false 가 된다.
    const viewerId = authorOf(c)
    const post = (await query<Record<string, unknown>>(
      `${postSelect(2)} where p.id = $1`, [postId, viewerId],
    )).rows[0]
    if (!post) return c.json({ error: 'not_found', message: '게시글을 찾을 수 없습니다.' }, 404)
    return c.json({ ...shapePost(post), places: (await loadPostPlaces([postId])).get(postId) ?? [] })
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
    return c.json({ ...shapePost(post), places: (await loadPostPlaces([postId])).get(postId) ?? [] }, 201)
  })

  /**
   * 게시글 수정 — 본인 글만. 온 키만 갱신한다.
   *
   * ⚠️ 남의 글이면 403 이 아니라 **404** 다 — 삭제 라우트와 같은 규칙이라 앱의 분기가
   *    하나로 끝나고, 남의 글 존재 여부도 새어 나가지 않는다.
   * ⚠️ 배열은 부분 병합이 아니라 **통째 교체**다(플랜 저장과 같은 판단). 부분 병합 API 는
   *    클라이언트가 순서를 맞추다 중간 상태를 저장하게 만든다.
   * ⚠️ authorNm 을 받지 않는다. 프로필 편집(042)이 생겼으니 글을 고친다고 닉네임이 따라
   *    바뀌면 안 된다 — 생성 라우트의 부수효과는 하위호환으로 남겨 둔다.
   */
  v1.patch('/posts/:postId', async (c) => {
    const gate = requireAuth(c)
    if (gate instanceof Response) return gate
    const postId = parsePostId(c.req.param('postId'))
    if (postId == null) return c.json(postNotFound, 404)

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

    // ── 검증은 생성과 동일하다. 온 키만 본다.
    const sets: string[] = []
    const vals: unknown[] = [postId, gate.authorId]
    const add = (sql: string, v: unknown) => { vals.push(v); sets.push(sql.replace('?', `$${vals.length}`)) }

    if (p.body !== undefined) {
      const body = str(p.body)
      if (!body) return c.json({ error: 'missing_body', message: '내용은 비어 있을 수 없습니다.' }, 400)
      if (body.length > MAX_POST_BODY) {
        return c.json({ error: 'body_too_long', message: `내용은 ${MAX_POST_BODY}자 이하여야 합니다.` }, 400)
      }
      add('body = ?', body)
    }

    if (p.imageURLs !== undefined) {
      if (!Array.isArray(p.imageURLs)) {
        return c.json({ error: 'invalid_body', message: 'imageURLs 는 배열이어야 합니다.' }, 400)
      }
      const imageURLs = p.imageURLs.filter((u): u is string => typeof u === 'string')
      if (imageURLs.length > MAX_POST_IMAGES) {
        return c.json({ error: 'too_many_images', message: `사진은 ${MAX_POST_IMAGES}장 이하여야 합니다.` }, 400)
      }
      add('image_urls = ?', imageURLs)
    }

    if (p.accessFeatures !== undefined) {
      if (!Array.isArray(p.accessFeatures)) {
        return c.json({ error: 'invalid_body', message: 'accessFeatures 는 배열이어야 합니다.' }, 400)
      }
      // 값은 검증하지 않는다(생성과 같은 판단 — 앱이 아이콘을 늘리면 서버 배포 없이 따라간다).
      const features = [...new Set(
        p.accessFeatures.filter((v) => typeof v === 'string' && v.trim()).map(String),
      )].slice(0, 10)
      add('access_features = ?', features)
    }

    // places 는 별도 테이블이라 위 set 목록에 넣을 수 없다. 온 경우에만 통째로 갈아낀다.
    let places: { contentID: string; name: string; region: string }[] | null = null
    if (p.places !== undefined) {
      if (!Array.isArray(p.places)) {
        return c.json({ error: 'invalid_body', message: 'places 는 배열이어야 합니다.' }, 400)
      }
      if (p.places.length > MAX_POST_PLACES) {
        return c.json({ error: 'too_many_places', message: `장소는 ${MAX_POST_PLACES}곳 이하여야 합니다.` }, 400)
      }
      places = p.places.map((v) => {
        const o = (v ?? {}) as Record<string, unknown>
        return { contentID: str(o.contentID), name: str(o.name), region: str(o.region) }
      })
      if (places.some((pl) => !pl.contentID || !pl.name)) {
        return c.json({ error: 'invalid_place', message: '장소는 contentID 와 name 이 필요합니다.' }, 400)
      }
    }

    if (sets.length === 0 && places === null) {
      return c.json({ error: 'nothing_to_update', message: '바꿀 항목이 없습니다.' }, 400)
    }

    const ok = await withTransaction(async (client) => {
      // 소유자 조건을 update 에 함께 넣어 남의 글은 0행이 되게 한다(삭제 라우트와 같은 방식).
      //  places 만 오는 요청에도 소유권 확인이 필요하므로 updated_at 은 항상 갱신한다.
      const res = await client.query(
        `update posts set ${[...sets, 'updated_at = now()'].join(', ')}
          where id = $1 and author_id = $2`,
        vals,
      )
      if (res.rowCount === 0) return false

      if (places !== null) {
        await client.query('delete from post_places where post_id = $1', [postId])
        for (const [i, pl] of places.entries()) {
          await client.query(
            `insert into post_places (post_id, position, content_id, place_name, region)
             values ($1, $2, $3, $4, $5)`,
            [postId, i, pl.contentID, pl.name, pl.region || null],
          )
        }
      }
      return true
    })
    if (!ok) return c.json({ error: 'not_found', message: '게시글을 찾을 수 없습니다.' }, 404)

    // 응답은 생성과 같은 모양 — 앱이 목록 카드와 상세를 한 번에 갱신한다.
    const post = (await query<Record<string, unknown>>(
      `${postSelect(2)} where p.id = $1`, [postId, gate.authorId],
    )).rows[0]!
    return c.json({ ...shapePost(post), places: (await loadPostPlaces([postId])).get(postId) ?? [] })
  })

  v1.delete('/posts/:postId', async (c) => {
    const gate = requireAuth(c)
    if (gate instanceof Response) return gate
    const authorId: number | null = gate.authorId
    if (authorId == null) return c.json({ error: 'not_found', message: '게시글을 찾을 수 없습니다.' }, 404)

    const postId = parsePostId(c.req.param('postId'))
    if (postId == null) return c.json(postNotFound, 404)
    const result = await query('delete from posts where id = $1 and author_id = $2',
      [postId, authorId])
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
  /**
   * 게시글 작성자에게 좋아요·댓글을 알린다.
   *
   * ⚠️ **자기 행동에는 보내지 않는다** — 내 글에 내가 좋아요·댓글을 달았을 때.
   * ⚠️ await 하지만 pushToAuthor 는 던지지 않는다(push.ts 주석) — 알림 실패가 원 요청을
   *    깨뜨리면 사용자는 자기 행동이 실패한 것으로 본다.
   */
  const notifyPostActor = async (
    postId: string, actorId: number, kind: 'like' | 'comment', commentBody?: string, commentId?: string,
  ) => {
    const row = (await query<{ author_id: number; actor: string; blocked: boolean }>(
      `select p.author_id, (select nickname from authors where id = $2) as actor,
              exists (select 1 from blocks b
                       where b.blocker_id = p.author_id and b.blocked_id = $2) as blocked
         from posts p where p.id = $1`, [postId, actorId],
    )).rows[0]
    if (!row || Number(row.author_id) === actorId) return   // 없는 글 · 자기 행동
    // 차단한 사람의 좋아요·댓글로는 알림이 가지 않는다(048) — 가리기만 하면 알림으로 존재가 샌다.
    if (row.blocked) return

    if (kind === 'like') {
      await pushToAuthor(Number(row.author_id), {
        title: '모두와',
        body: `${row.actor}님이 회원님의 글을 좋아합니다`,
        data: { type: 'post_like', postId },
        threadId: `post:${postId}`,
      }, `post_like:${postId}:${actorId}`)
    } else {
      // 댓글은 대화라 매번 보낸다 — eventKey 에 댓글 id 를 넣어 억제되지 않게 한다.
      await pushToAuthor(Number(row.author_id), {
        title: '모두와',
        body: `${row.actor}님이 댓글을 남겼어요: ${quote(commentBody ?? '')}`,
        data: { type: 'post_comment', postId },
        threadId: `post:${postId}`,
      }, commentId ? `post_comment:${commentId}` : undefined)
    }
  }

  const setPostLike = async (c: Context, liked: boolean) => {
    const gate = requireAuth(c)
    if (gate instanceof Response) return gate

    const postId = parsePostId(c.req.param('postId'))
    if (postId == null) return c.json(postNotFound, 404)
    const exists = (await query('select 1 from posts where id = $1', [postId])).rowCount
    if (!exists) return c.json(postNotFound, 404)

    if (liked) {
      const authorId = gate.authorId
      await query(
        `insert into post_likes (post_id, author_id) values ($1, $2)
         on conflict (post_id, author_id) do nothing`, [postId, authorId])
      // 알림은 **켜질 때만**. 끄는 것은 알릴 일이 아니다.
      //  eventKey 에 (글, 누른 사람)을 넣어 껐다 켜기를 반복해도 창 안에서 한 번만 간다.
      await notifyPostActor(postId, authorId, 'like')
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

  // ── 후기 신고 ───────────────────────────────────────────────────────────────
  //  ⚠️ **신고가 후기를 감추지 않는다.** 처리는 운영 판단이고, 자동으로 숨기면 신고 버튼이
  //     "남의 글을 지우는 도구" 가 된다. 앱도 신고 후 그 후기를 그대로 보여준다.
  //  사유는 앱이 쥔 고정 6종이다. 화이트리스트로 막는 이유는 화면에 없는 사유가 통계에 섞이면
  //  운영이 판단할 수 없기 때문이다(값 자유도를 주는 accessFeatures 와 반대 판단).
  // ── 차단(048) ───────────────────────────────────────────────────────────────
  //
  //  심사 규칙 1.2: 사용자 생성 콘텐츠 앱은 신고·차단을 모두 갖춰야 한다.
  //
  //  ⚠️ **단방향 + 쓰기 차단이다.** ① 내가 차단한 사람의 글·후기·댓글이 내 목록에서 사라지고
  //     알림도 오지 않는다. ② 그 사람은 내 글에 새 댓글을 달 수 없다(403). ①만 하면 차단해도
  //     댓글은 계속 달리고 알림만 막힌 상태가 된다(앱 팀 결정).
  //
  //  ⚠️ **라우트만 열고 목록을 그대로 두면 심사에서 "차단이 동작하지 않는다" 로 잡힌다.**
  //     아래 blockFilter 를 목록 쿼리마다 끼우는 것이 이 기능의 본체다.

  /** uuid 로 계정을 찾는다. 없거나 탈퇴했으면 null. */
  const authorByUuid = async (uuid: string): Promise<number | null> => {
    if (!/^[0-9a-fA-F-]{36}$/.test(uuid)) return null
    const row = (await query<{ id: number }>(
      'select id from authors where uuid = $1 and deleted_at is null', [uuid])).rows[0]
    return row ? Number(row.id) : null
  }

  //  차단 목록 — 설정의 "차단한 사용자" 화면. **해제할 길이 함께 있어야** 차단을 열 수 있다.
  v1.get('/blocks', async (c) => {
    const gate = requireAuth(c)
    if (gate instanceof Response) return gate
    const rows = (await query<{ uuid: string; nickname: string; avatar_url: string | null }>(
      `select a.uuid, a.nickname, a.avatar_url
         from blocks b join authors a on a.id = b.blocked_id
        where b.blocker_id = $1 order by b.created_at desc`, [gate.authorId])).rows
    return c.json({
      count: rows.length,
      items: rows.map((r) => ({ uuid: r.uuid, nickname: r.nickname, avatarUrl: toHttps(r.avatar_url) })),
    })
  })

  v1.post('/blocks', async (c) => {
    const gate = requireAuth(c)
    if (gate instanceof Response) return gate

    let payload: unknown
    try {
      payload = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_json', message: 'JSON 본문을 파싱할 수 없습니다.' }, 400)
    }
    const uuid = typeof (payload as Record<string, unknown>)?.uuid === 'string'
      ? ((payload as Record<string, unknown>).uuid as string).trim() : ''
    const targetId = await authorByUuid(uuid)
    if (targetId == null) {
      return c.json({ error: 'not_found', message: '사용자를 찾을 수 없습니다.' }, 404)
    }
    // 자기 차단은 막는다 — 통과시키면 내 글이 내 목록에서 사라진다(제약도 걸려 있다, 048).
    if (targetId === gate.authorId) {
      return c.json({ error: 'invalid_target', message: '자신을 차단할 수 없습니다.' }, 400)
    }
    // 재차단은 새 행이 아니다 — 멱등하게 204(좋아요·신고와 같은 판단).
    await query(
      `insert into blocks (blocker_id, blocked_id) values ($1, $2) on conflict do nothing`,
      [gate.authorId, targetId])
    return c.body(null, 204)
  })

  //  해제 — 없는 것도 204 다(멱등). 이미 없는 것을 지우는 요청에 오류를 줄 이유가 없다.
  v1.delete('/blocks/:uuid', async (c) => {
    const gate = requireAuth(c)
    if (gate instanceof Response) return gate
    const targetId = await authorByUuid(c.req.param('uuid') ?? '')
    // 없는 사람이면 지울 것도 없다 — 204 로 끝낸다(404 를 주면 앱이 오류창을 띄운다).
    if (targetId != null) {
      await query('delete from blocks where blocker_id = $1 and blocked_id = $2',
        [gate.authorId, targetId])
    }
    return c.body(null, 204)
  })

  const REPORT_REASONS = new Set(['spam', 'abuse', 'falseInfo', 'privacyLeak', 'irrelevant', 'other'])
  const MAX_REPORT_DETAIL = 300

  /**
   * 신고할 수 있는 대상(047). 앱은 시트 한 벌을 대상만 바꿔 재사용한다(앱 팀).
   *
   * table 은 **이 맵의 고정 문자열만** 쿼리에 들어간다 — targetType 을 그대로 이어 붙이면
   * SQL 주입이다. 맵에 없는 값은 400 으로 끊는다.
   */
  const REPORT_TARGETS = {
    post: { table: 'posts', uuid: true, label: '게시글' },
    post_comment: { table: 'post_comments', uuid: false, label: '댓글' },
    review: { table: 'reviews', uuid: false, label: '후기' },
    review_comment: { table: 'review_comments', uuid: false, label: '댓글' },
  } as const

  type ReportTargetType = keyof typeof REPORT_TARGETS

  /**
   * 신고를 기록한다. 라우트 셋(신규 /v1/reports · 기존 후기 신고)이 함께 쓴다.
   *
   * ⚠️ **자기 것을 신고하면 기록하지 않고 204 를 준다.** 오류가 아니다 — 앱이 오류창을 띄울
   *    이유가 없고(앱 팀 요청), 자기 신고는 운영 신호가 아니라 잡음이다. 게다가 자기 글을
   *    반복 신고해 "신고 많은 대상" 통계를 밀어 올리는 길을 막는다.
   *
   * 반환: 'ok' | 'not_found'
   */
  const recordReport = async (
    targetType: ReportTargetType, targetId: string, reporterId: number,
    reason: string, detail: string | null,
  ): Promise<'ok' | 'not_found'> => {
    const target = REPORT_TARGETS[targetType]
    // 대상 테이블은 넷이라 FK 를 걸 수 없다(047) — 여기서 존재를 확인한다.
    //  table 은 위 맵의 고정 문자열이다.
    const found = (await query<{ author_id: number }>(
      `select author_id from ${target.table} where id = $1`, [targetId])).rows[0]
    if (!found) return 'not_found'
    if (Number(found.author_id) === reporterId) return 'ok'   // 자기 것 — 조용히 무시

    // 같은 사람의 재신고는 새 행이 아니라 갱신이다 — 멱등하게 204 를 준다(좋아요와 같은 판단).
    await query(
      `insert into reports (target_type, target_id, author_id, reason, detail)
       values ($1, $2, $3, $4, $5)
         on conflict (target_type, target_id, author_id)
         do update set reason = excluded.reason, detail = excluded.detail, updated_at = now()`,
      [targetType, targetId, reporterId, reason, detail],
    )
    return 'ok'
  }

  /** 신고 본문에서 사유·상세를 꺼낸다. 형식이 틀리면 Response 를 돌려준다. */
  const readReportBody = async (c: Context): Promise<Response | { reason: string; detail: string | null }> => {
    let payload: unknown
    try {
      payload = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_json', message: 'JSON 본문을 파싱할 수 없습니다.' }, 400)
    }
    const p = (payload ?? {}) as Record<string, unknown>
    const reason = typeof p.reason === 'string' ? p.reason.trim() : ''
    // 화면에 없는 사유가 통계에 섞이면 운영이 판단할 수 없다 — 화이트리스트로 막는다.
    if (!REPORT_REASONS.has(reason)) {
      return c.json({ error: 'invalid_reason', message: '신고 사유가 올바르지 않습니다.' }, 400)
    }
    const detail = typeof p.detail === 'string' ? p.detail.trim().slice(0, MAX_REPORT_DETAIL) : ''
    return { reason, detail: detail || null }
  }

  /**
   * 신고 — 대상을 필드로 받는다(앱 팀 제안 A).
   *
   * 대상별로 라우트를 늘리지 않는다. 신고할 자리가 늘 때마다 라우트가 늘면, 앱은 시트 하나로
   * 끝나는데 서버만 계속 커진다.
   */
  v1.post('/reports', async (c) => {
    const gate = requireAuth(c)
    if (gate instanceof Response) return gate

    let payload: unknown
    try {
      payload = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_json', message: 'JSON 본문을 파싱할 수 없습니다.' }, 400)
    }
    const p = (payload ?? {}) as Record<string, unknown>
    const targetType = typeof p.targetType === 'string' ? p.targetType.trim() : ''
    if (!(targetType in REPORT_TARGETS)) {
      return c.json({
        error: 'invalid_target_type',
        message: `targetType 은 ${Object.keys(REPORT_TARGETS).join(' · ')} 중 하나여야 합니다.`,
      }, 400)
    }
    const kind = targetType as ReportTargetType

    // ⚠️ 형식 검증을 여기서 한다. uuid 컬럼에 'abc' 를 넘기면 Postgres 가 캐스팅에 실패해
    //    404 가 아니라 **500** 이 된다(게시글 라우트에서 겪은 것과 같은 함정).
    const rawId = typeof p.targetId === 'string' ? p.targetId.trim() : ''
    const targetId = REPORT_TARGETS[kind].uuid ? parsePostId(rawId) : parseCommentId(rawId)
    if (targetId == null) {
      return c.json({ error: 'not_found', message: '신고 대상을 찾을 수 없습니다.' }, 404)
    }

    const body = await readReportBody(c)
    if (body instanceof Response) return body

    const result = await recordReport(kind, targetId, gate.authorId, body.reason, body.detail)
    if (result === 'not_found') {
      return c.json({ error: 'not_found', message: '신고 대상을 찾을 수 없습니다.' }, 404)
    }
    return c.body(null, 204)
  })

  v1.post('/reviews/:reviewId/report', async (c) => {
    const gate = requireAuth(c)
    if (gate instanceof Response) return gate

    const reviewId = parseReviewId(c.req.param('reviewId') ?? '')
    if (reviewId == null) return c.json({ error: 'not_found', message: '후기를 찾을 수 없습니다.' }, 404)

    let payload: unknown
    try {
      payload = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_json', message: 'JSON 본문을 파싱할 수 없습니다.' }, 400)
    }
    const body = await readReportBody(c)
    if (body instanceof Response) return body

    // 앱이 이미 쓰고 있어 URL 은 남기지만, 기록은 reports 한 곳에 모은다(047).
    //  두 표에 나뉘어 있으면 운영이 볼 곳이 둘이 된다.
    const result = await recordReport('review', String(reviewId), gate.authorId, body.reason, body.detail)
    if (result === 'not_found') {
      return c.json({ error: 'not_found', message: '후기를 찾을 수 없습니다.' }, 404)
    }
    return c.body(null, 204)
  })

  // ── 푸시 알림 기기 토큰(044) ────────────────────────────────────────────────
  //  발송 코드는 APNs 인증 키(.p8)가 도착한 뒤에 붙는다. 등록은 그와 독립이라 먼저 연다 —
  //  앱이 권한 요청·등록을 먼저 붙일 수 있고, 키가 오면 대상이 이미 쌓여 있다.
  const DEVICE_ENVIRONMENTS = new Set(['sandbox', 'production'])

  v1.post('/devices', async (c) => {
    const gate = requireAuth(c)
    if (gate instanceof Response) return gate

    let payload: unknown
    try {
      payload = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_json', message: 'JSON 본문을 파싱할 수 없습니다.' }, 400)
    }
    const p = (payload ?? {}) as Record<string, unknown>
    const token = typeof p.token === 'string' ? p.token.trim() : ''
    // APNs 기기 토큰은 hex 문자열이다. 형식을 막아 두면 잘못된 값이 발송 대상에 쌓이지 않는다.
    if (!/^[0-9a-fA-F]{32,200}$/.test(token)) {
      return c.json({ error: 'invalid_token', message: '기기 토큰 형식이 올바르지 않습니다.' }, 400)
    }
    const environment = typeof p.environment === 'string' ? p.environment.trim() : ''
    // ⚠️ 여기서 막지 않으면 잘못된 게이트웨이로 보내 BadDeviceToken 으로 **조용히** 실패한다.
    if (!DEVICE_ENVIRONMENTS.has(environment)) {
      return c.json({
        error: 'invalid_environment',
        message: "environment 는 'sandbox' 또는 'production' 이어야 합니다.",
      }, 400)
    }
    const platform = typeof p.platform === 'string' && p.platform.trim() ? p.platform.trim() : 'ios'
    const bundleId = typeof p.bundleId === 'string' ? p.bundleId.trim() : ''

    // 토큰이 PK 라 재등록은 upsert 다. **author_id 까지 갱신**하는 것이 중요하다 —
    //  한 기기를 다른 계정으로 로그인하면 소유자가 바뀌어야 하고, 안 그러면 로그아웃한
    //  사람에게 알림이 계속 간다.
    await query(
      `insert into device_tokens (token, author_id, platform, environment, bundle_id)
       values ($1, $2, $3, $4, $5)
         on conflict (token) do update
           set author_id = excluded.author_id, platform = excluded.platform,
               environment = excluded.environment, bundle_id = excluded.bundle_id,
               updated_at = now()`,
      [token, gate.authorId, platform, environment, bundleId || null],
    )
    return c.body(null, 204)
  })

  //  해제는 로그아웃·알림 스위치 끄기에서 부른다. 남의 토큰을 지우지 못하게 소유자 조건을 건다.
  //   없는 토큰도 204 다 — 이미 없는 것을 지우려는 요청에 오류를 줄 이유가 없다(멱등).
  v1.delete('/devices/:token', async (c) => {
    const gate = requireAuth(c)
    if (gate instanceof Response) return gate
    await query(
      'delete from device_tokens where token = $1 and author_id = $2',
      [c.req.param('token') ?? '', gate.authorId],
    )
    return c.body(null, 204)
  })

  // ── 게시글 댓글 ─────────────────────────────────────────────────────────────

  /// 게시글과 같은 규칙이다 — $VIEWER 는 보는 사람의 author_id(없으면 null).
  const POST_COMMENT_SELECT = `
    select c.id, a.nickname as author, a.avatar_url as author_avatar, a.uuid as author_uuid, c.body,
           coalesce(c.author_id = $VIEWER, false) as "isMine",
           to_char(c.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "createdAt"
      from post_comments c
      join authors a on a.id = c.author_id`

  const postCommentSelect = (viewerParam: number) =>
    POST_COMMENT_SELECT.replaceAll('$VIEWER', `$${viewerParam}`)

  /** 게시글 댓글에 작성자 프로필을 덧붙인다(042). 내부 컬럼명이 새어 나가지 않게 감싼다. */
  const shapePostComment = (row: Record<string, unknown>) => {
    const { author_avatar: avatar, author_uuid: uuid, ...rest } = row as {
      author_avatar?: string | null; author_uuid?: string | null
    } & Record<string, unknown>
    return {
      ...rest,
      authorInfo: {
        nickname: rest.author as string, avatarUrl: toHttps(avatar ?? null),
        uuid: uuid ?? null,
      },
    }
  }

  // 오래된 순 — 대화 순서다(리뷰 댓글과 같다).
  v1.get('/posts/:postId/comments', async (c) => {
    const { limit, offset } = paging(c)
    const postId = parsePostId(c.req.param('postId'))
    if (postId == null) return c.json(postNotFound, 404)
    // 보는 사람 = 세션의 계정. 목록 자체는 공개라 비로그인이면 null 이고 isMine 은 false 다.
    const viewerId = authorOf(c)
    // total 도 같은 조건으로 센다 — 어긋나면 페이지 개수가 맞지 않는다.
    const total = (await query<{ n: number }>(
      `select count(*)::int n from post_comments c
        where c.post_id = $1 and ${blockFilter('c.author_id', 2)}`, [postId, viewerId])).rows[0]!.n
    const rows = (await query(
      `${postCommentSelect(2)} where c.post_id = $1 and ${blockFilter('c.author_id', 2)}
        order by c.created_at limit ${limit} offset ${offset}`, [postId, viewerId],
    )).rows
    return c.json({
      total, limit, offset, count: rows.length, items: rows.map(shapePostComment),
    })
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

    const postId = parsePostId(c.req.param('postId'))
    if (postId == null) return c.json(postNotFound, 404)
    const owner = (await query<{ author_id: number; blocked: boolean }>(
      `select p.author_id,
              exists (select 1 from blocks b
                       where b.blocker_id = p.author_id and b.blocked_id = $2) as blocked
         from posts p where p.id = $1`, [postId, gate.authorId])).rows[0]
    if (!owner) return c.json(postNotFound, 404)
    // ⚠️ **쓰기 차단**(048). 가리기만 하면 차단해도 댓글은 계속 달리고 알림만 막힌 상태가 된다.
    //  404 가 아니라 403 이다 — 글은 실제로 존재하고 앱이 "차단되어 쓸 수 없다" 를 말해야 한다.
    if (owner.blocked) {
      return c.json({
        error: 'blocked_by_author', message: '이 게시글에는 댓글을 쓸 수 없습니다.',
      }, 403)
    }

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
      `${postCommentSelect(2)} where c.id = $1`, [commentId, gate.authorId])).rows[0]!
    await notifyPostActor(postId, gate.authorId, 'comment', body, String(commentId))
    return c.json(shapePostComment(comment), 201)
  })

  /**
   * 게시글 댓글 수정 · 삭제 — **본인 것만**(앱 팀 요청).
   *
   * 남의 것·없는 것·형식이 틀린 것 모두 **404** 다. 403 으로 갈라 주면 앱 분기가 둘로 늘고,
   * "있지만 남의 것" 이라는 사실이 새어 나간다 — 게시글 수정·삭제와 같은 규칙이다.
   *
   * 소유자 조건을 update/delete 문에 함께 넣어 0행이면 404 로 떨어뜨린다. 먼저 조회해서
   * 비교하면 그 사이에 남이 지울 수 있다(경합).
   */
  v1.patch('/posts/:postId/comments/:commentId', async (c) => {
    const gate = requireAuth(c)
    if (gate instanceof Response) return gate
    const postId = parsePostId(c.req.param('postId'))
    const commentId = parseCommentId(c.req.param('commentId'))
    if (postId == null) return c.json(postNotFound, 404)
    if (commentId == null) return c.json(commentNotFound, 404)

    let payload: unknown
    try {
      payload = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_json', message: 'JSON 본문을 파싱할 수 없습니다.' }, 400)
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return c.json({ error: 'invalid_body', message: 'JSON 객체를 보내주세요.' }, 400)
    }
    const body = typeof (payload as Record<string, unknown>).body === 'string'
      ? ((payload as Record<string, unknown>).body as string).trim() : ''
    // 검증은 작성과 같다(앱 팀 요청). 빈 값을 허용하면 수정이 사실상 두 번째 삭제 경로가 된다.
    if (!body) return c.json({ error: 'missing_body', message: '댓글은 비어 있을 수 없습니다.' }, 400)
    if (body.length > 1000) {
      return c.json({ error: 'body_too_long', message: '댓글은 1000자 이하여야 합니다.' }, 400)
    }

    const updated = await query(
      `update post_comments set body = $1
        where id = $2 and post_id = $3 and author_id = $4`,
      [body, commentId, postId, gate.authorId])
    if (updated.rowCount === 0) return c.json(commentNotFound, 404)

    const row = (await query<Record<string, unknown>>(
      `${postCommentSelect(2)} where c.id = $1`, [commentId, gate.authorId])).rows[0]!
    return c.json(shapePostComment(row))
  })

  //  하드 삭제다 — 대댓글이 없어 남길 맥락이 없다(앱 팀 확인). 게시글의 commentCount 는
  //   저장된 카운터가 아니라 조회마다 세는 값이라(POST_SELECT) 따로 줄일 것이 없다.
  v1.delete('/posts/:postId/comments/:commentId', async (c) => {
    const gate = requireAuth(c)
    if (gate instanceof Response) return gate
    const postId = parsePostId(c.req.param('postId'))
    const commentId = parseCommentId(c.req.param('commentId'))
    if (postId == null) return c.json(postNotFound, 404)
    if (commentId == null) return c.json(commentNotFound, 404)

    const deleted = await query(
      'delete from post_comments where id = $1 and post_id = $2 and author_id = $3',
      [commentId, postId, gate.authorId])
    if (deleted.rowCount === 0) return c.json(commentNotFound, 404)
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
