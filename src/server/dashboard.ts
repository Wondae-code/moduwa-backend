// 수집 현황 대시보드 라우트 — /dashboard
//
// 조회 전용이며 비밀번호 뒤에 있다. DATABASE_URL 이 가리키는 DB 를 그대로 보여주므로
// 로컬에서 띄우면 수집 원본 전체가, 배포본에서 띄우면 관리형 슬림 DB 가 보인다.
import { Hono } from 'hono';
import { config } from '../config';
import {
  checkPassword, clearFailedLogins, clearSessionCookie, isLoggedIn, issueToken,
  loginAttemptsLeft, recordFailedLogin, requireLogin, setSessionCookie,
} from './dashboard-auth';
import { browse, listTables, overview, runConsoleQuery } from './dashboard-data';
import { dashboardPage, loginPage } from './dashboard-page';

export function buildDashboard(): Hono {
  const dash = new Hono();

  // 로그인 화면 자체는 열려 있어야 한다.
  dash.use('*', async (c, next) => {
    const p = c.req.path;
    if (p === '/dashboard/login' || p === '/dashboard/logout') return next();
    return requireLogin(c, next);
  });

  dash.get('/login', (c) => (isLoggedIn(c) ? c.redirect('/dashboard', 302) : c.html(loginPage())));

  dash.post('/login', async (c) => {
    if (loginAttemptsLeft(c) <= 0) {
      return c.html(loginPage('시도 횟수를 초과했습니다. 10분 뒤에 다시 시도하세요.'), 429);
    }
    const body = await c.req.parseBody();
    const pw = typeof body['password'] === 'string' ? body['password'] : '';
    if (!checkPassword(pw)) {
      recordFailedLogin(c);
      const left = loginAttemptsLeft(c);
      return c.html(loginPage(`비밀번호가 올바르지 않습니다. (남은 시도 ${left}회)`), 401);
    }
    clearFailedLogins(c);
    setSessionCookie(c, issueToken());
    return c.redirect('/dashboard', 302);
  });

  dash.post('/logout', (c) => {
    clearSessionCookie(c);
    return c.redirect('/dashboard/login', 302);
  });

  dash.get('/', (c) => c.html(dashboardPage()));

  // ── JSON API (화면이 쓰는 것) ──
  dash.get('/api/overview', async (c) => c.json(await overview()));

  dash.get('/api/tables', async (c) => {
    const tables = await listTables();
    return c.json({ tables });
  });

  dash.get('/api/browse', async (c) => {
    const table = c.req.query('table') ?? '';
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50) || 50));
    // 깊은 offset 은 큰 테이블에서 느려지기만 하므로 상한을 둔다 — 그 뒤는 SQL 콘솔의 일이다.
    const offset = Math.min(100_000, Math.max(0, Number(c.req.query('offset') ?? 0) || 0));
    try {
      return c.json(await browse(table, limit, offset));
    } catch (err) {
      return c.json({ error: 'bad_request', message: (err as Error).message }, 400);
    }
  });

  dash.post('/api/query', async (c) => {
    const body = await c.req.json<{ sql?: string }>().catch(() => ({ sql: '' }));
    try {
      return c.json(await runConsoleQuery(body.sql ?? ''));
    } catch (err) {
      const e = err as Error & { code?: string };
      const msg = e.code === '57014'
        ? `쿼리가 ${config.dashboard.queryTimeoutMs / 1000}초를 초과해 중단됐습니다.`
        : e.message;
      return c.json({ error: 'query_failed', message: msg }, 400);
    }
  });

  return dash;
}
