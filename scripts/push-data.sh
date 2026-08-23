#!/bin/bash
# 로컬(colima) Postgres → 관리형 Postgres 로 "API가 쓰는 테이블만" 동기화.
# API는 pet_friendly_view(+의존 테이블) 와 locgo_hub_detail 만 읽는다.
# tar_rlte(3.8GB)·datalab·tats·kor_poi 등 수집 원본은 배포 대상 아님 → 제외(관리형 디스크 절약).
#
# 테이블별 순차 교체(각각 단일 트랜잭션) — 전체 원자성 대신 볼륨 요구를 낮춘다.
#  · 단일 트랜잭션 전체 교체는 커밋 전까지 구·신 데이터가 공존해 전체 크기의 ~2배가 필요했고,
#    Railway 소형 볼륨에서 "No space left on device"로 실패했다.
#  · 테이블별 교체는 일시 여유 공간이 "가장 큰 테이블 1개" 수준이면 충분하다.
#  · 테이블 사이에 CHECKPOINT 로 WAL 재활용을 유도해 피크 사용량을 더 낮춘다.
#  · pet_friendly_view 는 테이블들에 의존하는 뷰라 먼저 드롭하고 마지막에 재생성한다.
# 로컬 psql 불필요 — 컨테이너(moduwa-postgres)의 pg_dump/psql 경유.
# 사용: TARGET_DATABASE_URL="postgresql://user:pass@host:port/db" bash scripts/push-data.sh
set -euo pipefail

: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL 환경변수를 설정하세요 (관리형 DB 공개 접속 URL)}"

# API가 실제로 참조하는 테이블 (뷰 제외 — 뷰는 마지막에 별도 처리)
#
#  🚫 reviews / authors 는 의도적으로 제외한다 — 절대 다시 넣지 말 것.
#     쓰기 API(POST /v1/reviews, 017)가 생긴 뒤로 리뷰의 소스는 "관리형(prod) DB"다.
#     이 스크립트는 pg_dump --clean --if-exists 로 테이블을 통째로 drop → 재생성한다.
#     여기에 reviews 를 포함하면 유저가 앱에서 작성한 리뷰가 다음 동기화에서 전부 소실되고,
#     authors 를 포함하면 reviews.author_id 참조까지 함께 날아간다(복구 불가).
#     → 리뷰 스키마 변경은 데이터 동기화가 아니라 prod 에 마이그레이션(npm run migrate)으로 반영한다.
#     (012_reviews.sql 상단 경고 참고)
#
#  ✅ related_places 는 반대로 반드시 포함해야 한다 — 로컬이 소스다.
#     018 이 이 테이블을 tar_rlte_records(357만행, 로컬 전용)로 계산하는데 관리형 DB 에는
#     그 원천 테이블이 없다. 즉 prod 에서 npm run migrate 로 재계산하는 것은 불가능하고
#     (relation "tar_rlte_records" does not exist), 계산 결과를 데이터로 실어 보내는 길밖에 없다.
#     → barrier_free 를 갱신했으면 로컬에서 018 을 재실행한 뒤 이 스크립트를 돌린다.
#  ✅ kakao_place · tats_region_daily 도 반드시 포함한다 — 추천(035·036)이 요청 시점에 읽는다.
#     없으면 prod 추천이 조용히 열등해진다: 혼잡도가 항상 null 이고, 카페 슬롯에 순두부집이,
#     아침 자리에 횟집이 들어간다(실제로 그 상태로 배포돼 있었다).
#     · kakao_place       34MB. 카페 판별(CE7)과 식사 시간대(세부 분류)의 유일한 출처.
#     · tats_region_daily 1,300여 행. tats_cnctr(440MB)를 지역·날짜별 평균으로 미리 집계한 것.
#
#  ❌ 반대로 tats_cnctr(440MB)·locgo_hub_records(394MB)는 **보내지 않는다.**
#     요청 시점에 읽히지 않는다. 전자는 위 집계로 대체되고, 후자의 결과인 hub_rank 는
#     barrier_free 컬럼에 실려 함께 간다.
TABLES="pet_tour_poi pet_tour_detail kor_with_detail kor_detail locgo_hub_detail barrier_free related_places kakao_place tats_region_daily"
DUMP="/tmp/moduwa-slim-$(date +%Y%m%d%H%M%S).sql"
trap 'rm -f "$DUMP"' EXIT

psql_target() { docker exec -i moduwa-postgres psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 "$@"; }

echo "① 의존 뷰 드롭 (테이블 교체를 막지 않도록) + 확장 준비"
psql_target -c "drop view if exists pet_friendly_view;"
# barrier_free 의 trgm 인덱스(015)가 덤프에 포함되므로 대상에도 확장 필요
psql_target -c "create extension if not exists pg_trgm;"

echo "② 테이블별 순차 교체 (각각 단일 트랜잭션)"
for t in $TABLES; do
  echo "   ── $t ($(date '+%H:%M:%S'))"
  docker exec moduwa-postgres pg_dump -U moduwa -d moduwa \
    --no-owner --no-acl --clean --if-exists -t "$t" > "$DUMP"
  psql_target -1 < "$DUMP" | tail -1
  # WAL 재활용 유도 (권한 없으면 무시)
  psql_target -c "checkpoint;" >/dev/null 2>&1 || true
done

echo "③ 뷰 재생성"
docker exec moduwa-postgres pg_dump -U moduwa -d moduwa \
  --no-owner --no-acl --clean --if-exists -t pet_friendly_view > "$DUMP"
psql_target -1 < "$DUMP" | tail -1

echo "④ 검증 (행 수)"
psql_target -c "
  select 'pet_tour_poi' t, count(*) n from pet_tour_poi
  union all select 'pet_tour_detail', count(*) from pet_tour_detail
  union all select 'kor_with_detail', count(*) from kor_with_detail
  union all select 'kor_detail', count(*) from kor_detail
  union all select 'locgo_hub_detail', count(*) from locgo_hub_detail
  union all select 'pet_friendly_view', count(*) from pet_friendly_view
  union all select 'barrier_free', count(*) from barrier_free;"

# reviews/authors 는 동기화 대상이 아니다 — prod 값을 그대로 보여주기만 한다(변화가 없어야 정상).
echo "⑤ 동기화 제외 테이블 현황 (prod 소스 — 이 값은 변하지 않아야 한다)"
psql_target -c "
  select 'reviews(제외)' t, count(*) n from reviews
  union all select 'authors(제외)', count(*) from authors;" 2>/dev/null \
  || echo "   (reviews/authors 미생성 — prod 에 npm run migrate 를 먼저 적용하세요)"

echo "✅ 동기화 완료"
