// 대시보드 비밀번호 인증 — 로그인 폼 + HMAC 서명 쿠키. 외부 의존성 없음.
//
// 쿠키에는 "만료시각과 그 서명"만 담는다. 세션 저장소가 없으므로 인스턴스가 재시작해도
// 로그인이 유지되고, 반대로 비밀번호(=서명 키)를 바꾸면 발급된 쿠키가 전부 즉시 무효가 된다.
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import type { Context, Next } from 'hono';
import { config } from '../config';

const COOKIE = 'moduwa_dash';

/** 서명 키. DASHBOARD_SESSION_SECRET 미설정 시 비밀번호에서 파생한다. */
function secret(): string {
  const explicit = config.dashboard.sessionSecret;
  if (explicit) return explicit;
  return createHash('sha256').update(`moduwa-dash:${config.dashboard.password}`).digest('hex');
}

/** 길이가 달라도 안전하게 비교 — 해시를 거쳐 항상 같은 길이로 만든 뒤 상수시간 비교. */
function equals(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function issueToken(): string {
  const exp = Date.now() + config.dashboard.sessionHours * 3600_000;
  return `${exp}.${sign(String(exp))}`;
}

function verifyToken(token: string | undefined): boolean {
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  const exp = token.slice(0, dot);
  if (!/^\d+$/.test(exp) || Number(exp) <= Date.now()) return false;
  return equals(token.slice(dot + 1), sign(exp));
}

export function checkPassword(input: string): boolean {
  const pw = config.dashboard.password;
  // 라우트 자체가 비밀번호 없이는 등록되지 않지만, 방어적으로 한 번 더 막는다.
  return pw.length > 0 && equals(input, pw);
}

// ── 쿠키 ─────────────────────────────────────────────────────────────────────
function readCookie(c: Context, name: string): string | undefined {
  const raw = c.req.header('cookie');
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/** Railway 등 프록시 뒤에서는 x-forwarded-proto 로 원 요청의 스킴을 판단한다. */
function isHttps(c: Context): boolean {
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  return proto ? proto === 'https' : new URL(c.req.url).protocol === 'https:';
}

export function setSessionCookie(c: Context, token: string): void {
  const maxAge = config.dashboard.sessionHours * 3600;
  const attrs = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'Path=/dashboard',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (isHttps(c)) attrs.push('Secure');
  c.header('Set-Cookie', attrs.join('; '));
}

export function clearSessionCookie(c: Context): void {
  c.header('Set-Cookie', `${COOKIE}=; Path=/dashboard; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function isLoggedIn(c: Context): boolean {
  return verifyToken(readCookie(c, COOKIE));
}

// ── 로그인 시도 제한 ──────────────────────────────────────────────────────────
//  단일 인스턴스 인메모리. 무차별 대입을 "막는" 게 아니라 실용적으로 무의미하게 만드는 용도.
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 10 * 60_000;

function clientId(c: Context): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'anon';
}

/** 남은 시도 횟수. 0이면 잠금 상태. */
export function loginAttemptsLeft(c: Context): number {
  const cur = attempts.get(clientId(c));
  if (!cur || Date.now() >= cur.resetAt) return MAX_ATTEMPTS;
  return Math.max(0, MAX_ATTEMPTS - cur.count);
}

export function recordFailedLogin(c: Context): void {
  const id = clientId(c);
  const now = Date.now();
  const cur = attempts.get(id);
  if (!cur || now >= cur.resetAt) attempts.set(id, { count: 1, resetAt: now + WINDOW_MS });
  else cur.count += 1;
}

export function clearFailedLogins(c: Context): void {
  attempts.delete(clientId(c));
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) if (now >= v.resetAt) attempts.delete(k);
}, 300_000).unref?.();

/** /dashboard/* 보호. 미인증이면 페이지는 로그인으로, API는 401 JSON. */
export async function requireLogin(c: Context, next: Next): Promise<Response | void> {
  if (isLoggedIn(c)) return next();
  if (c.req.path.startsWith('/dashboard/api/')) {
    return c.json({ error: 'unauthorized', message: '세션이 만료되었습니다. 다시 로그인하세요.' }, 401);
  }
  return c.redirect('/dashboard/login', 302);
}
