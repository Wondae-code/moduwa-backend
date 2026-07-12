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
