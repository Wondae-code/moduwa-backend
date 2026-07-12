-- 한국관광공사 관광지별 연관관광지 정보 (TarRlteTarService1 / areaBasedList1)
-- 수집 단위: (기준연월 baseYm × 시군구 signguCd)
--
-- 1) tar_rlte_tasks   : 수집 작업 큐 — 무엇을 받았고/남았는지 (체크포인트·재개의 핵심)
-- 2) tar_rlte_records : 파싱된 개별 레코드 (관광지 → 연관관광지 1쌍 = 1행), 멱등 upsert
-- 3) ingest_runs      : 실행(=하루치) 단위 로그 — 요청수·중단사유 추적

-- 이전 범용 스캐폴드 테이블 정리(비어있음)
drop table if exists records cascade;
drop table if exists raw_pages cascade;
drop table if exists ingestion_runs cascade;

create table if not exists tar_rlte_tasks (
  id          bigserial primary key,
  base_ym     text        not null,                 -- 기준연월 YYYYMM
  area_cd     text        not null,                 -- 시도코드(법정동)
  signgu_cd   text        not null,                 -- 시군구코드(법정동)
  signgu_nm   text,
  status      text        not null default 'pending', -- pending|done|nodata|error
  total_count integer,                              -- API totalCount
  pages       integer,                              -- 받은 페이지 수
  fetched     integer     not null default 0,       -- 적재한 item 수
  result_code text,
  error       text,
  attempts    integer     not null default 0,
  started_at  timestamptz,
  updated_at  timestamptz not null default now(),
  unique (base_ym, signgu_cd)
);

create index if not exists idx_tasks_status on tar_rlte_tasks (status, base_ym desc, signgu_cd);

create table if not exists tar_rlte_records (
  id            bigserial primary key,
  base_ym       text not null,
  -- 기준 관광지
  t_ats_cd      text not null,                       -- 관광지코드
  t_ats_nm      text,
  area_cd       text not null,
  area_nm       text,
  signgu_cd     text not null,
  signgu_nm     text,
  -- 연관 관광지
  rlte_tats_cd       text not null,                  -- 연관관광지코드
  rlte_tats_nm       text,
  rlte_regn_cd       text,                           -- 연관 시도코드
  rlte_regn_nm       text,
  rlte_signgu_cd     text,
  rlte_signgu_nm     text,
  rlte_ctgry_lcls_nm text,                           -- 연관 카테고리 대분류
  rlte_ctgry_mcls_nm text,                           -- 중분류
  rlte_ctgry_scls_nm text,                           -- 소분류
  rlte_rank          integer,                        -- 연관순위
  -- 메타
  raw           jsonb not null,                      -- item 원본 (응답 기록)
  natural_key   text  not null,                      -- baseYm:signguCd:tAtsCd:rlteTatsCd
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (natural_key)
);

create index if not exists idx_rec_base_ym     on tar_rlte_records (base_ym);
create index if not exists idx_rec_signgu      on tar_rlte_records (base_ym, signgu_cd);
create index if not exists idx_rec_t_ats       on tar_rlte_records (t_ats_cd);
create index if not exists idx_rec_rlte_tats   on tar_rlte_records (rlte_tats_cd);
create index if not exists idx_rec_t_ats_nm    on tar_rlte_records (t_ats_nm);

create table if not exists ingest_runs (
  id               bigserial primary key,
  base_ym_start    text,
  base_ym_end      text,
  requests_made    integer not null default 0,
  tasks_done       integer not null default 0,
  records_upserted integer not null default 0,
  stopped_reason   text,                             -- completed|daily-cap|api-limit|error
  started_at       timestamptz not null default now(),
  finished_at      timestamptz
);
