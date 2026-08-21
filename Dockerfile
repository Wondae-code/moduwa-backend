# moduwa 관광 데이터 API — 배포용 이미지
FROM node:22-slim

WORKDIR /app

# 의존성 먼저(레이어 캐시). tsx는 dependencies에 있어 --omit=dev 에도 포함됨.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 소스 + 마이그레이션 SQL
COPY src ./src
COPY sql ./sql
COPY tsconfig.json ./

ENV NODE_ENV=production
# 플랫폼이 PORT를 주입하면 그걸 사용(config에서 읽음). 기본 8080.
EXPOSE 8080

# ⚠️ 마이그레이션을 여기서 돌리지 않는다.
#  `alter table ... add column if not exists` 는 **컬럼이 이미 있어도** ACCESS EXCLUSIVE 락을
#  잡는다. 배포 중에는 구버전 컨테이너가 barrier_free 를 계속 읽고 있어 그 락을 얻지 못하고,
#  lock_timeout 에 걸려 기동이 실패한다(실제로 크래시 루프로 서비스가 내려갔다).
#  마이그레이션은 배포와 분리해 별도로 실행한다 — docs/DEPLOY.md 참고.
CMD ["npm", "start"]
