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
    /** 세션 발급 당시의 기기. **클라이언트가 보낸 deviceId 보다 이 값을 신뢰한다.** */
    sessionDeviceId: string;
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
 * 요청자의 IP. X-Forwarded-For 의 **오른쪽에서** 신뢰 홉 수만큼 세어 얻는다.
 *
 * ⚠️ 첫 항목(맨 왼쪽)을 쓰면 안 된다. 그 값은 클라이언트가 임의로 넣을 수 있고 프록시는
 *    실제 IP 를 뒤에 덧붙인다. 왼쪽을 신뢰하면 `X-Forwarded-For: 1.2.3.4` 를 매 요청
 *    바꾸는 것만으로 IP 기준 제한이 전부 무의미해진다.
 */
export function clientIp(c: Context<AppEnv>): string {
  const hops = config.auth.trustedProxyHops;
  const parts = (c.req.header('x-forwarded-for') ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  // 신뢰하는 프록시가 hops 개면 XFF 항목이 최소 hops 개는 있어야 한다(각 프록시가 하나씩
  //  덧붙인다). 그보다 적으면 그 헤더는 프록시가 아니라 **클라이언트가 만든 것**이므로
  //  한 글자도 신뢰하지 않는다 — 여기서 신뢰하면 헤더 한 줄로 IP 기준 제한이 전부 무의미해진다.
  if (parts.length < hops) return 'untrusted';

  // 홉 1 = 마지막 항목(우리 앞의 프록시가 적은 실제 클라이언트 IP).
  return parts[parts.length - hops] ?? 'untrusted';
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
// 세션 없이 들어와야 하는 경로. 만료된 토큰을 아직 못 지운 앱이 **재로그인조차 못 하는**
//  상태를 막는다(토큰이 붙어 있으면 401 이 나서 로그인 요청 자체가 막힌다).
//  비밀번호 재설정도 포함한다 — 비밀번호를 잊은 사람은 낡은 토큰을 들고 있을 가능성이 높고,
//  그 토큰 때문에 재설정이 401 이 되면 계정을 되찾을 길이 막힌다.
const SESSION_OPTIONAL_PATHS = [
  '/v1/auth/email/sign-in',
  '/v1/auth/email/sign-up',
  '/v1/auth/email/forgot',
  '/v1/auth/email/reset',
];

export async function sessionAuth(c: Context<AppEnv>, next: Next): Promise<Response | void> {
  const token = c.req.header(SESSION_HEADER)?.trim();
  if (!token) return next();

  const session = await resolveSession(token);
  if (!session) {
    // 로그인·가입은 낡은 토큰이 있어도 통과시킨다 — 그러지 않으면 만료된 토큰을 들고 있는
    // 앱은 로그인을 할 수 없고, 사용자가 앱 데이터를 지우는 것 말고는 탈출 방법이 없다.
    if (SESSION_OPTIONAL_PATHS.includes(c.req.path)) return next();
    return c.json({ error: 'session_expired', message: '로그인이 만료되었습니다. 다시 로그인해주세요.' }, 401);
  }
  c.set('authorId', session.authorId);
  c.set('sessionToken', token);
  // 발급 당시의 기기. 로그아웃 뒷정리는 클라이언트가 보낸 deviceId 대신 이 값을 쓴다.
  if (session.deviceId) c.set('sessionDeviceId', session.deviceId);
  return next();
}

// ── 인메모리 고정창(fixed-window) 레이트 리밋. 단일 인스턴스 기준. ──
const hits = new Map<string, { count: number; resetAt: number }>();

export async function rateLimit(c: Context<AppEnv>, next: Next): Promise<Response | void> {
  const limit = config.api.rateLimitPerMin;
  if (limit <= 0) return next();

  // 키 기준(없으면 IP). 배포 플랫폼이 넣어주는 헤더를 우선 사용.
  const id = c.get('apiKey') || clientIp(c);

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
