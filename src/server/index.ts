// API 서버 부트스트랩
import { serve } from '@hono/node-server';
import { config } from '../config';
import { buildApp } from './app';
import { scheduleFeedbackPurge } from './feedback';

const app = buildApp();
// 피드백 보관 기간(접수 후 1년)을 지킨다. 개인정보 처리방침 4항이 약속한 것이다.
scheduleFeedbackPurge();
const port = config.api.port;

serve({ fetch: app.fetch, port }, (info) => {
  const authMode = config.api.keys.length > 0 ? `API키 ${config.api.keys.length}개` : '⚠️ 인증 없음(로컬)';
  console.log(`[api] moduwa API 서버 기동 · http://localhost:${info.port} · ${authMode} · 레이트리밋 ${config.api.rateLimitPerMin}/분`);
  console.log(config.dashboard.password
    ? `[api] 대시보드 · http://localhost:${info.port}/dashboard (비밀번호 로그인 · 세션 ${config.dashboard.sessionHours}시간)`
    : '[api] 대시보드 비활성 — DASHBOARD_PASSWORD 미설정');
});
