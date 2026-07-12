#!/bin/bash
# 로컬(colima) Postgres → 관리형 Postgres 로 "API가 쓰는 테이블만" 동기화.
# API는 pet_friendly_view(+의존 테이블) 와 locgo_hub_detail 만 읽는다.
# tar_rlte(3.8GB)·datalab·tats·kor_poi 등 수집 원본은 배포 대상 아님 → 제외(관리형 디스크 절약).
# 무중단: 단일 트랜잭션으로 교체(DDL 트랜잭션) → 커밋 전까지 기존 데이터가 계속 서비스됨.
# 로컬 psql 불필요 — 컨테이너(moduwa-postgres)의 pg_dump/psql 경유.
# 사용: TARGET_DATABASE_URL="postgresql://user:pass@host:port/db" bash scripts/push-data.sh
set -euo pipefail

: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL 환경변수를 설정하세요 (관리형 DB 공개 접속 URL)}"

# API가 실제로 참조하는 것만 (뷰 + 의존 테이블)
TABLES="-t pet_tour_poi -t pet_tour_detail -t kor_with_detail -t kor_detail -t locgo_hub_detail -t pet_friendly_view"
DUMP="/tmp/moduwa-slim-$(date +%Y%m%d%H%M%S).sql"

echo "① 슬림 덤프 (API 대상 테이블만, --clean 포함)"
docker exec moduwa-postgres pg_dump -U moduwa -d moduwa \
  --no-owner --no-acl --clean --if-exists $TABLES > "$DUMP"
echo "   덤프 크기: $(du -h "$DUMP" | cut -f1)"

echo "② 관리형 DB로 원자적 교체 (단일 트랜잭션 → 무중단)"
docker exec -i moduwa-postgres psql "$TARGET_DATABASE_URL" -1 -v ON_ERROR_STOP=1 < "$DUMP" | tail -3

echo "③ 검증 (행 수)"
docker exec moduwa-postgres psql "$TARGET_DATABASE_URL" -c "
  select 'pet_tour_poi' t, count(*) n from pet_tour_poi
  union all select 'pet_tour_detail', count(*) from pet_tour_detail
  union all select 'kor_with_detail', count(*) from kor_with_detail
  union all select 'kor_detail', count(*) from kor_detail
  union all select 'locgo_hub_detail', count(*) from locgo_hub_detail
  union all select 'pet_friendly_view', count(*) from pet_friendly_view;"

rm -f "$DUMP"
echo "✅ 동기화 완료 (임시 덤프 삭제됨)"
