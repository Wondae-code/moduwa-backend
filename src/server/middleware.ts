// API 키 인증 · 레이트 리밋 미들웨어 (Hono)
import type { Context, Next } from 'hono';
import { config } from '../config';

/**
 * API 키 인증. `Authorization: Bearer <key>` 또는 `x-api-key: <key>` 허용.
 * config.api.keys 가 비어 있으면(로컬 개발) 인증을 건너뛴다.
 */
export async function apiKeyAuth(c: Context, next: Next): Promise<Response | void> {
  const keys = config.api.keys;
  if (keys.length === 0) return next(); // 로컬 개발: 키 미설정 시 통과

  const auth = c.req.header('authorization');
  const bearer = auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const provided = bearer || c.req.header('x-api-key')?.trim() || '';

  if (!provided || !keys.includes(provided)) {
    return c.json({ error: 'unauthorized', message: '유효한 API 키가 필요합니다 (Authorization: Bearer <key>).' }, 401);
  }
  c.set('apiKey', provided);
  return next();
}

// ── 인메모리 고정창(fixed-window) 레이트 리밋. 단일 인스턴스 기준. ──
const hits = new Map<string, { count: number; resetAt: number }>();

export async function rateLimit(c: Context, next: Next): Promise<Response | void> {
  const limit = config.api.rateLimitPerMin;
  if (limit <= 0) return next();

  // 키 기준(없으면 IP). 배포 플랫폼이 넣어주는 헤더를 우선 사용.
  const id =
    (c.get('apiKey') as string | undefined) ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    'anon';

  const now = Date.now();
  const cur = hits.get(id);
  if (!cur || now >= cur.resetAt) {
    hits.set(id, { count: 1, resetAt: now + 60_000 });
  } else {
    cur.count += 1;
    if (cur.count > limit) {
      const retry = Math.ceil((cur.resetAt - now) / 1000);
      c.header('Retry-After', String(retry));
      return c.json({ error: 'rate_limited', message: `분당 ${limit}회 초과. ${retry}s 후 재시도.` }, 429);
    }
  }
  return next();
}

// 오래된 버킷 정리(메모리 누수 방지).
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (now >= v.resetAt) hits.delete(k);
}, 300_000).unref?.();
