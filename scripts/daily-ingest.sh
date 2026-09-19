#!/bin/bash
# 매일 자동 수집용 래퍼 (cron에서 호출).
# cron의 최소 환경을 고려해 PATH·HOME 설정 후 colima/Postgres 기동을 보장하고 ingest 실행.
set -uo pipefail

export HOME="/Users/wondae"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

PROJECT="/Users/wondae/Projects/moduwa-backend"
cd "$PROJECT" || exit 1

mkdir -p "$PROJECT/logs"
LOG="$PROJECT/logs/daily-ingest-$(date +%Y%m%d).log"

{
  echo "════════ $(date '+%Y-%m-%d %H:%M:%S') daily-ingest 시작 ════════"

  # 1) colima(도커 런타임) 기동 보장
  if ! colima status >/dev/null 2>&1; then
    echo "[wrap] colima 미실행 → 시작"
    colima start || { echo "[wrap] colima 시작 실패"; exit 1; }
  fi

  # 2) Postgres 컨테이너 기동 보장
  docker compose up -d || { echo "[wrap] docker compose 실패"; exit 1; }

  # 3) healthy 대기 (최대 ~60s)
  for _ in $(seq 1 30); do
    h="$(docker inspect --format '{{.State.Health.Status}}' moduwa-postgres 2>/dev/null || echo none)"
    if [ "$h" = "healthy" ]; then break; fi
    sleep 2
  done
  echo "[wrap] postgres health=$h"

  # 4) 수집 — 각 서비스는 독립 일일쿼터라 순차 실행해도 서로 경쟁하지 않음.
  #    queue형(연관관광지·기초지자체중심)은 남은 작업만 이어서, 단발형은 최신 갱신.
  for cmd in ingest ingest:locgo ingest:tats ingest:datalab ingest:kor ingest:korwith ingest:areadiv ingest:withdetail ingest:kordetail ingest:kakao ingest:locgo-detail ingest:pet ingest:pet-detail ingest:barrier-free; do
    echo "──── npm run $cmd ($(date '+%H:%M:%S')) ────"
    npm run "$cmd" || echo "[wrap] $cmd 실패 — 계속 진행"
  done

  # 4-2) 혼잡도 집계 — ingest:tats 가 finally 에서 부르지만, **여기서 한 번 더 돌린다.**
  #      2026-09-19 실측: data.go.kr 지연으로 ingest:tats 가 78분 걸리다 exit 0 으로 조용히
  #      끝났는데(✅ 완료 없음), finally 의 집계도 안 돌았다 — await 없이 부른 main() 에서
  #      이벤트 루프가 비면 Node 는 0 으로 빠져나가고 finally 는 실행되지 않는다. 그러면 원본은
  #      늘었는데 집계는 전날 값으로 push 되어, 09-16 에 고친 그 병이 다른 문으로 돌아온다.
  #      집계는 0.4초짜리 group by 하나라 두 번 도는 비용이 없고, 원본이 비어 있으면 스스로
  #      건너뛴다(congestion.ts 가드). 수집이 전부 실패해도 어제 원본으로 집계는 맞는다.
  echo "──── npm run aggregate:congestion ($(date '+%H:%M:%S')) ────"
  npm run aggregate:congestion || echo "[wrap] 혼잡도 집계 실패 — 전날 집계로 push 된다"

  # 5) 관리형 DB 동기화 — API용 슬림 테이블만 push (무거운 원본은 로컬에만 유지).
  #    .env 에 MANAGED_DATABASE_URL 이 설정돼 있으면 실행. 없으면 조용히 건너뜀.
  MANAGED_URL="$(grep -E '^MANAGED_DATABASE_URL=' "$PROJECT/.env" 2>/dev/null | cut -d= -f2-)"
  if [ -n "${MANAGED_URL:-}" ]; then
    echo "──── 관리형 DB 슬림 동기화 ($(date '+%H:%M:%S')) ────"
    TARGET_DATABASE_URL="$MANAGED_URL" bash "$PROJECT/scripts/push-data.sh" || echo "[wrap] 동기화 실패 — 다음 실행에서 재시도"
  else
    echo "[wrap] MANAGED_DATABASE_URL 미설정 — 관리형 동기화 생략"
  fi

  echo "════════ $(date '+%Y-%m-%d %H:%M:%S') 완료 ════════"
} >> "$LOG" 2>&1
