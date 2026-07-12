# moduwa-backend

한국관광공사 TourAPI(공공데이터포털, data.go.kr) 관광 데이터를 **PostgreSQL에 수집·적재**하고,
그 위에 **읽기 전용 REST API**를 제공하는 백엔드.

대용량이어도 **페이지네이션 + 체크포인트 재개 + 멱등 upsert + 일일 쿼터 자동 중단**으로 안전하게 나눠 수집한다.

## 아키텍처

```
[data.go.kr / Kakao]
      │  수집(ingest:*)  ── 무거운 원본 포함 전량
      ▼
[로컬 Postgres (colima)]  ── 슬림 동기화(push-data.sh, ~100MB) ──▶ [관리형 Postgres (Railway)]
                              API가 쓰는 5테이블 + 뷰만                        │
                                                                  [API 서버(Hono, 읽기전용)]
                                                                                │ Authorization: Bearer <key>
                                                                            개발자
```
- **수집은 로컬**(tar_rlte 3.8GB 등 원본까지). **API용 슬림 테이블만** 관리형으로 매일 동기화 → 관리형 디스크 절약.
- API는 **SELECT만**. 비밀값은 `.env`/플랫폼 환경변수에만(git 제외).

## 수집하는 데이터 (한국관광공사 TourAPI)

| 서비스 | 스크립트 | 주요 테이블 | 비고 |
|---|---|---|---|
| 연관관광지(TarRlte) | `ingest` | `tar_rlte_records` | 월별 연관 관광지 |
| 지역 대표 관광지(LocgoHub) | `ingest:locgo` | `locgo_hub_records` | 기초지자체 중심, 좌표 100% |
| 관광지 집중률(TatsCnctr) | `ingest:tats` | `tats_cnctr` | 방문자 추이 |
| 관광 빅데이터(DataLab) | `ingest:datalab` | `datalab_visitor` | 검색·방문 |
| 국문 관광정보(KorService2) | `ingest:kor` | `kor_poi` | 전국 POI |
| 무장애 여행(KorWithService2) | `ingest:korwith` | `kor_poi(service=korwith)` | |
| KorService2 상세 | `ingest:kordetail` | `kor_detail` | 개요·운영시간(가볼곳 유형) |
| 무장애 상세 | `ingest:withdetail` | `kor_with_detail` | 28속성(휠체어·안내견 등) |
| 카카오 로컬 보강 | `ingest:kakao`, `ingest:locgo-detail` | `locgo_hub_detail`, `kakao_place` | 전화·업종·지도링크·사진 |
| **반려동물 동반여행(KorPetTour)** | `ingest:pet`, `ingest:pet-detail` | `pet_tour_poi`, `pet_tour_detail` | 동반유형·동반가능동물 |

### API가 노출하는 것 (슬림)
- `pet_friendly_view` — 반려동물 동반 관광지 9,767곳 + 안내견(무장애) + 개요·운영시간을 `content_id`로 결합
- `locgo_hub_detail` — 지역 대표 관광지 54,478곳(카카오/네이버 지도링크 100% + TourAPI 소개·사진 + 카카오 전화·업종)

## 기술 스택
Node.js + TypeScript(tsx) · PostgreSQL · Hono(API) · Docker(colima) · Railway(배포)

## 저장소 구조
```
sql/                  스키마 마이그레이션(001~010, 순서대로 적용)
src/config.ts         .env 로딩 (수집·카카오·API 설정)
src/db.ts             pg Pool + 트랜잭션 헬퍼
src/client.ts         data.go.kr 호출 (재시도·응답 정규화·일일한도 감지)
src/util.ts           엔드포인트 상수, 청크 upsert
src/ingest-*.ts       서비스별 수집기 (재개 가능)
src/migrate.ts        sql/*.sql 적용
src/server/           REST API (app.ts 라우트 · middleware.ts 인증/레이트리밋 · index.ts 부트스트랩)
scripts/daily-ingest.sh   매일 전량 수집 + 관리형 슬림 동기화 (cron)
scripts/push-data.sh      로컬→관리형 슬림 동기화(무중단, 단일 트랜잭션)
scripts/gen-api-key.mjs   API 키 생성
docs/DEPLOY.md, docs/API.md
```

## 로컬 시작하기
```bash
npm install
cp .env.example .env          # DATA_GO_KR_SERVICE_KEY 등 채우기
npm run db:up                 # colima Postgres 기동
npm run migrate               # 스키마 생성
npm run ingest:pet            # 예: 반려동물 목록 수집
npm run api                   # API 로컬 실행 (기본 :8080)
```

## 수집 운영
- 개발계정은 **오퍼레이션별 1,000건/일**. `INGEST_DAILY_REQUEST_CAP=900`으로 여유 두고 자동 중단, 다음 실행에서 **남은 작업만 이어서**(재개) 진행.
- 매일 자동: `scripts/daily-ingest.sh`를 cron에 등록(colima·Postgres 기동 보장 → 전 서비스 수집 → 관리형 동기화).
- 진행 현황: `npm run stats`.

## 데이터 최신 유지 (관리형)
로컬 수집 후 **API용 슬림 테이블만** 관리형으로 push한다.
```bash
# 1회/수동
TARGET_DATABASE_URL="<관리형 공개 URL>" bash scripts/push-data.sh
# 자동: .env 에 MANAGED_DATABASE_URL 설정 → daily-ingest.sh 가 매일 동기화
```
무중단(단일 트랜잭션 교체)이라 동기화 중에도 API는 기존 데이터를 계속 서비스한다.

## REST API
읽기 전용. `/v1/*`는 **API 키 필수**(`Authorization: Bearer <key>`), 키 없으면 401. → **[docs/API.md](docs/API.md)**

배포 URL: `https://moduwa-backend-production.up.railway.app`

## 배포 (Railway)
GitHub 연동 → Postgres + Dockerfile 서비스 → 환경변수(`DATABASE_URL`,`API_KEYS`,…) → 슬림 데이터 push. → **[docs/DEPLOY.md](docs/DEPLOY.md)**

## 데이터 출처·라이선스
한국관광공사 TourAPI(data.go.kr). 표출 시 **출처 표시** 필요. 사진은 저작권코드(`image_copyright`: Type1=변경금지, Type3=출처표시) 준수.
