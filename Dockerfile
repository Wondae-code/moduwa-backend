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

# 부팅 시 마이그레이션을 먼저 돌린다.
#  · migrate 는 적용 이력(schema_migrations)을 보고 **바뀐 파일만** 실행한다. 평소에는
#    0.2초 안에 끝나므로 기동이 느려지지 않는다.
#  · 어드바이저리 락으로 한 프로세스만 진행한다. 배포 중 구·신 컨테이너가 겹쳐도
#    둘이 같은 alter table 을 물고 교착되지 않는다(그것 때문에 한 번 502 로 내려갔다).
#  · 관리형 DB 의 DATABASE_URL 은 내부 호스트라 컨테이너 안에서만 해석된다. 여기서 돌리면
#    DB 비밀값을 밖으로 꺼내지 않아도 된다.
#  · 실패하면 서버가 뜨지 않는다. 스키마가 어긋난 채 요청을 받는 것보다 낫다.
CMD ["npm", "run", "start:deploy"]
