#!/usr/bin/env node
// 안전한 API 키 생성기. 사용: node scripts/gen-api-key.mjs [개수]
import { randomBytes } from 'node:crypto';

const n = Math.max(1, Number(process.argv[2] ?? 1) || 1);
const keys = Array.from({ length: n }, () => 'mdw_' + randomBytes(24).toString('base64url'));

console.log(keys.join('\n'));
console.error(`\n↑ ${n}개 생성. .env 의 API_KEYS 에 콤마로 넣거나 배포 플랫폼 환경변수에 설정하세요.`);
console.error('예) API_KEYS=' + keys.join(','));
