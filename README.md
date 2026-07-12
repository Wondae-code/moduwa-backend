# moduwa-backend

공공데이터포털(data.go.kr) API를 페이지 단위로 수집해 **PostgreSQL에 적재**하는 파이프라인.
데이터가 많아도 **페이지네이션 + 체크포인트 재개 + 멱등 upsert**로 안전하게 나눠서 가져온다.

## 구조

```
sql/001_init.sql   스키마 (ingestion_runs / raw_pages / records)
src/config.ts      .env 로딩
src/db.ts          pg Pool + 트랜잭션 헬퍼
src/client.ts      data.go.kr 페이지 fetch (재시도·JSON 정규화)
src/dataset.ts     ★ 데이터셋별 자연키 추출 — 엔드포인트 정해지면 여기 수정
src/ingest.ts      수집 루프 (체크포인트·재개·레이트리밋)
src/migrate.ts     sql/*.sql 적용
src/stats.ts       적재 현황 확인
```

### 테이블

| 테이블 | 역할 |
|---|---|
| `ingestion_runs` | 수집 작업 1건. `last_page`로 체크포인트, `status`로 상태 추적 |
| `raw_pages` | 페이지 단위 **원본 응답(JSONB)** — 감사·재처리용 ("응답 기록") |
| `records` | 파싱된 개별 레코드. `(dataset, natural_key)` 유니크 → 재실행해도 중복 없음 |

## 시작하기

```bash
# 1) 의존성 설치
npm install

# 2) 환경변수
cp .env.example .env
#   - DATA_GO_KR_SERVICE_KEY : "디코딩" 키 (인코딩 키 넣으면 인증 실패)
#   - DATA_GO_KR_BASE_URL    : 수집할 데이터셋 엔드포인트
#   - DATASET                : 데이터셋 구분 태그

# 3) PostgreSQL 기동 + 스키마 생성
npm run db:up
npm run migrate

# 4) (테스트) 1~2페이지만: .env에서 INGEST_MAX_PAGES=2 후
npm run ingest

# 5) 현황 확인
npm run stats
```

## 동작 방식

- **나눠서 수집**: `numOfRows`씩 페이지를 돌며 매 페이지를 트랜잭션으로 저장.
- **재개**: 중단/실패 시 `ingestion_runs.status='running'`인 run을 찾아 `last_page+1`부터 이어감.
  처음부터 다시 하려면 `npm run ingest:reset`.
- **멱등성**: `records`는 자연키 upsert, `raw_pages`는 `(run_id, page_no)` upsert. 재실행 안전.
- **레이트리밋/재시도**: 호출 간 `INGEST_REQUEST_DELAY_MS` 딜레이, 페이지 실패 시 지수 백오프 재시도.

## 데이터셋 연결 (엔드포인트 확정 후)

1. `.env`의 `DATA_GO_KR_BASE_URL`에 base URL 입력 (쿼리스트링 제외).
2. `src/dataset.ts`의 `naturalKey()`를 해당 데이터셋의 PK 필드로 수정.
3. `DATASET` 태그 지정 후 `npm run ingest`.

## 적재 데이터 조회 예시

```sql
-- 특정 필드로 조회 (JSONB)
select data->>'title', data->>'addr1' from records where dataset = 'public-data' limit 20;

-- 원본 페이지 응답 확인
select page_no, item_count, result_msg from raw_pages order by page_no;
```
