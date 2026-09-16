-- 추천이 prod 에서도 제대로 돌게 한다 — 혼잡도 집계 + 파생 테이블 보호.
--
-- ── 문제
--  추천은 로컬에서 잘 나오는데 prod 결과가 눈에 띄게 나빴다. 원인은 **원천 데이터가 prod 에
--  없다는 것**이다. push-data.sh 는 barrier_free 등 7개만 옮기고 tats_cnctr(혼잡도)·
--  kakao_place(카페·식사시간대)는 대상이 아니다. 그래서 prod 에서는 혼잡도가 항상 null 이고
--  아침 자리에 횟집이 들어갔다.
--
-- ── 왜 tats_cnctr 를 통째로 보내지 않나
--  440MB 다(raw 컬럼만 112MB). 그런데 추천이 실제로 읽는 것은 **지역·날짜별 평균** 하나뿐이다.
--  미리 집계하면 17개 시도 × 77일 ≈ 1,300행으로 줄고, 요청마다 66만 행을 훑던 것도 없어진다.
--  ⚠️ locgo_hub_records(394MB)는 아예 보낼 필요가 없다 — 요청 시점에 읽히지 않고,
--     결과인 hub_rank 는 barrier_free 컬럼에 실려 함께 간다.
--
--  migrate 는 내용 해시로 재적용을 판단하므로 이 파일은 멱등이어야 한다.

create table if not exists tats_region_daily (
  regn_cd   text not null,
  base_ymd  text not null,
  rate      numeric(6,2) not null,
  primary key (regn_cd, base_ymd)
);

-- ── 집계는 여기 있지 않다 (2026-09-16 이동)
--
--  예전에는 이 파일 안에서 delete + insert 로 집계했다. 그런데 **마이그레이션은 파일 해시가
--  바뀔 때만 다시 돈다** — 사실상 한 번 돌고 끝이다. ingest:tats 가 매일 원본을 늘려도 집계는
--  처음 값에 멈춰 있었고, 실제로 원본이 20261015 까지 있는데 집계는 20260913 에서 멈춰
--  **사용자가 고르는 미래 날짜의 혼잡도가 전부 null** 이 되어 있었다(추천이 통째로 빗나갔다).
--
--  그래서 집계를 src/congestion.ts 로 옮기고 **원본을 채우는 ingest-tats 가 끝에 부른다.**
--  원본과 집계가 같은 명령에서 함께 움직이면 다시 어긋날 자리가 없다.
--  수동 실행: `npm run aggregate:congestion`
--
--  ⚠️ 이 파일이 행을 지우지 않게 된 것이 그 자체로 안전 장치이기도 하다. 전에는
--     tats_cnctr 가 채워진 DB 에서 migrate 를 돌리면 집계를 지우고 다시 넣었는데,
--     prod 에 원본이 부분만 들어간 상태로 그게 돌면 push-data.sh 로 실어 보낸
--     온전한 집계가 부분 데이터로 덮인다. 이제 migrate 는 표만 만든다.
