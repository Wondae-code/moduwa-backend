// API 서버 부트스트랩
import { serve } from '@hono/node-server';
import { config } from '../config';
import { buildApp } from './app';

const app = buildApp();
const port = config.api.port;

serve({ fetch: app.fetch, port }, (info) => {
  const authMode = config.api.keys.length > 0 ? `API키 ${config.api.keys.length}개` : '⚠️ 인증 없음(로컬)';
  console.log(`[api] moduwa API 서버 기동 · http://localhost:${info.port} · ${authMode} · 레이트리밋 ${config.api.rateLimitPerMin}/분`);
});
