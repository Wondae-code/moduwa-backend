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

CMD ["npm", "start"]
