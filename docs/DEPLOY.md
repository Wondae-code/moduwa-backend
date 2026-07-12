# 배포 가이드 (관리형 서비스 + API 키 인증)

다른 개발자들이 HTTP로 관광 데이터를 조회하도록 REST API를 배포합니다.
**API 키가 없으면 401** — 아무나 curl로 못 엽니다.

## 아키텍처
```
[data.go.kr / Kakao]          (수집: 로컬 Mac 또는 Railway Cron)
        │  ingest:* (쓰기)
        ▼
[관리형 Postgres] ◀────── [API 서버(Hono, 읽기전용)] ◀── 개발자 (Authorization: Bearer <key>)
   Railway/Neon                Railway/Render
```
- API 서버는 **SELECT만** 한다(쓰기 없음). 수집은 별도 프로세스.
- 비밀값(DB URL, data.go.kr·Kakao 키, API_KEYS)은 **플랫폼 환경변수**에만. git엔 안 올린다(`.gitignore`).

## 0) 사전 준비 — API 키 생성
```bash
node scripts/gen-api-key.mjs 3      # 개발자 수만큼
# 출력된 키들을 콤마로 이어 API_KEYS 환경변수에 넣는다
```

## 1) 관리형 Postgres + API — Railway (추천, 한 곳에서)
1. https://railway.app 가입 → **New Project → Deploy PostgreSQL**
2. 같은 프로젝트에 **New → GitHub Repo**(이 저장소 연결) 또는 **Empty Service + Dockerfile**
   - 이 저장소엔 `Dockerfile` 이 있어 자동 인식됨
3. API 서비스 **Variables** 설정:
   ```
   DATABASE_URL   = ${{Postgres.DATABASE_URL}}   # Railway가 내부 URL 주입
   API_KEYS       = mdw_xxx,mdw_yyy              # 0)에서 생성
   ALLOWED_ORIGINS= *                            # 브라우저 직접호출 시 도메인 지정
   RATE_LIMIT_PER_MIN = 120
   ```
   (수집도 Railway에서 돌릴 거면 `DATA_GO_KR_SERVICE_KEY`, `KAKAO_REST_API_KEY` 도 추가)
4. API 서비스에 **Public Domain** 생성(Settings → Networking → Generate Domain)

> 대안: **API=Render + DB=Neon**. Render는 이 Dockerfile로 Web Service 생성, `DATABASE_URL` 에 Neon 접속문자열(`?sslmode=require`) 입력.

## 2) 스키마 생성 + 데이터 적재
관리형 DB는 처음엔 비어 있다. **마이그레이션 → 데이터 이관** 순.

```bash
# (a) 스키마 — 로컬에서 관리형 DB를 가리켜 실행
DATABASE_URL="<관리형 DATABASE_URL>" npm run migrate

# (b) 이미 수집한 데이터를 로컬 → 관리형으로 1회 이관 (재크롤 불필요)
TARGET_DATABASE_URL="<관리형 DATABASE_URL>" bash scripts/push-data.sh
```
`push-data.sh` 는 로컬 콘테이너를 `pg_dump` 해서 관리형에 복원하고 행 수까지 검증한다.

## 3) 배포 & 확인
Railway는 push/connect 시 자동 빌드·배포. 도메인이 `https://xxx.up.railway.app` 라면:
```bash
curl https://xxx.up.railway.app/health                 # {"status":"ok","db":"up"}
curl https://xxx.up.railway.app/v1/pet-friendly        # 401 (키 없음) ← 정상
curl -H "Authorization: Bearer mdw_xxx" \
     "https://xxx.up.railway.app/v1/pet-friendly?limit=1"   # 200 + 데이터
```

## 4) 데이터 최신 유지 (수집)
관리형 DB를 최신으로 유지하는 두 방법:
- **간단:** 로컬 Mac의 daily cron(`scripts/daily-ingest.sh`)이 쓰는 `DATABASE_URL` 을 관리형으로 바꾼다. 수집은 Mac에서 돌지만 데이터는 관리형에 쌓인다.
- **권장(무인):** Railway **Cron** 서비스를 추가해 `npm run <ingest 명령>` 을 매일 실행(같은 저장소, 같은 env + data.go.kr/Kakao 키). Mac 꺼져 있어도 수집됨.

## 5) 개발자에게 전달
- 배포 도메인 + 각자의 **API 키** 1개
- [docs/API.md](API.md) — 엔드포인트·인증·예제
- ⚠️ 데이터 출처: **한국관광공사 TourAPI(data.go.kr)** — 표출 시 출처 표시, 사진은 저작권코드(Type1=변경금지) 준수

## 보안 체크리스트
- [ ] `API_KEYS` 설정됨(비어 있으면 인증 OFF!) — 배포 전 필수
- [ ] `.env` 는 커밋 안 됨(`.gitignore` 확인)
- [ ] 관리형 Postgres는 공개 인터넷에 직접 노출 금지(내부 URL 사용, 필요 시 IP 허용목록)
- [ ] HTTPS 도메인으로만 배포(Railway/Render 기본 제공)
- [ ] 키 유출 시: `API_KEYS` 에서 제거 후 재배포 → 즉시 무효화
