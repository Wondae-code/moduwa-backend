#!/bin/bash
# 로컬(colima) Postgres 데이터를 관리형 Postgres로 1회 이관.
# 사용: TARGET_DATABASE_URL="postgresql://user:pass@host:5432/db" bash scripts/push-data.sh
set -euo pipefail

: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL 환경변수를 설정하세요 (관리형 DB 접속 URL)}"

DUMP="/tmp/moduwa-dump-$(date +%Y%m%d%H%M%S).sql"

echo "① 로컬 DB 덤프 (컨테이너 moduwa-postgres) → $DUMP"
docker exec moduwa-postgres pg_dump -U moduwa -d moduwa --no-owner --no-acl > "$DUMP"
echo "   덤프 크기: $(du -h "$DUMP" | cut -f1)"

echo "② 관리형 DB로 복원"
psql "$TARGET_DATABASE_URL" -f "$DUMP"

echo "③ 검증 (행 수)"
psql "$TARGET_DATABASE_URL" -c "
  select 'pet_tour_poi' t, count(*) from pet_tour_poi
  union all select 'pet_tour_detail', count(*) from pet_tour_detail
  union all select 'locgo_hub_detail', count(*) from locgo_hub_detail
  union all select 'kor_poi', count(*) from kor_poi;"

echo "✅ 이관 완료. 덤프 파일: $DUMP (확인 후 삭제 가능)"
