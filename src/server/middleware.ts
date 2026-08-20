// API 키 인증 · 사용자 세션 · 레이트 리밋 미들웨어 (Hono)
import type { Context, Next } from 'hono';
import { config } from '../config';
import { SESSION_HEADER, resolveSession } from './sessions';

/**
 * 미들웨어가 c.set 으로 넣는 값들. Hono 는 이 타입이 없으면 c.get 의 키를 never 로 본다.
 * 라우터를 만들 때 `new Hono<AppEnv>()` 로 넘겨 쓴다.
 */
export type AppEnv = {
  Variables: {
    /** apiKeyAuth 가 넣는다. 레이트리밋 버킷 키로 쓰인다. */
    apiKey: string;
    /** sessionAuth 가 넣는다. 로그인한 요청에만 있다. */
    authorId: number;
    /** sessionAuth 가 넣는다. 로그아웃에서 이 세션만 끊는 데 쓴다. */
    sessionToken: string;
  };
};

/**
 * API 키 인증. `Authorization: Bearer <key>` 또는 `x-api-key: <key>` 허용.
 * config.api.keys 가 비어 있으면(로컬 개발) 인증을 건너뛴다.
 */
export async function apiKeyAuth(c: Context<AppEnv>, next: Next): Promise<Response | void> {
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

/**
 * 사용자 세션 해석. **API 키 인증과 별개다** — 저쪽은 "이 앱이 호출해도 되는가",
 * 이쪽은 "이 요청이 누구인가"를 답한다.
 *
 * 토큰이 없으면 아무것도 하지 않고 통과시킨다. 로그인하지 않은 사용자도 계속 쓸 수 있어야 하고,
 * 그 경우 신원은 종전대로 deviceId 가 맡는다(app.ts 의 resolveAuthor).
 *
 * ⚠️ 토큰이 있는데 유효하지 않으면 **deviceId 로 폴백하지 않고 401** 이다.
 *    폴백하면 만료된 세션이 조용히 익명 계정으로 떨어져, 사용자에게는 "내 플랜이 전부
 *    사라졌다"로 보인다. 다시 로그인하라고 명확히 알려주는 편이 낫다.
 */
export async function sessionAuth(c: Context<AppEnv>, next: Next): Promise<Response | void> {
  const token = c.req.header(SESSION_HEADER)?.trim();
  if (!token) return next();

  const session = await resolveSession(token);
  if (!session) {
    return c.json({ error: 'session_expired', message: '로그인이 만료되었습니다. 다시 로그인해주세요.' }, 401);
  }
  c.set('authorId', session.authorId);
  c.set('sessionToken', token);
  return next();
}

// ── 인메모리 고정창(fixed-window) 레이트 리밋. 단일 인스턴스 기준. ──
const hits = new Map<string, { count: number; resetAt: number }>();

export async function rateLimit(c: Context<AppEnv>, next: Next): Promise<Response | void> {
  const limit = config.api.rateLimitPerMin;
  if (limit <= 0) return next();

  // 키 기준(없으면 IP). 배포 플랫폼이 넣어주는 헤더를 우선 사용.
  const id =
    c.get('apiKey') ||
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
