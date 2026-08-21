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
#  · sql/*.sql 은 전부 멱등으로 작성돼 있다(각 파일 상단 주석). 매 배포마다 재실행해도 안전하다.
#  · 관리형 DB 의 DATABASE_URL 은 내부 호스트(postgres.railway.internal)라 **컨테이너 안에서만**
#    해석된다. 로컬에서 원격 마이그레이션을 돌리려면 공개 URL(=DB 비밀값)을 밖으로 꺼내야 하는데,
#    그러지 않아도 되게 하는 것이 이 방식의 이점이다.
#  · 마이그레이션이 실패하면 서버가 뜨지 않는다. 스키마가 어긋난 채 요청을 받는 것보다 낫다
#    (이번에 028~031 을 빠뜨린 채 배포하면 인증 요청이 전부 500 이 됐다).
CMD ["npm", "run", "start:deploy"]
