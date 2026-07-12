-- 추가 공공데이터 API 적재 스키마
-- (1) kor_poi          : KorService2/KorWithService2 전국 관광 POI
-- (2) tats_cnctr       : 관광지 집중률(향후 30일)
-- (3) datalab_visitor  : 지역별 일별 방문자수(광역 metco / 기초 locgo)
-- (4) locgo_hub_*      : 기초지자체 중심 관광지(시군구×월) — 작업큐 + 레코드

create table if not exists kor_poi (
  id              bigserial primary key,
  service         text not null,            -- 'kor' | 'korwith'
  content_id      text not null,
  content_type_id text,
  title           text,
  addr1           text,
  addr2           text,
  zipcode         text,
  area_code       text,
  sigungu_code    text,
  ldong_regn_cd   text,
  ldong_signgu_cd text,
  cat1 text, cat2 text, cat3 text,
  lcls_systm1 text, lcls_systm2 text, lcls_systm3 text,
  mapx double precision,
  mapy double precision,
  mlevel text,
  tel text,
  firstimage text,
  firstimage2 text,
  created_time text,
  modified_time text,
  raw jsonb not null,
  natural_key text not null unique,         -- service:content_id
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_poi_service on kor_poi (service);
create index if not exists idx_poi_type    on kor_poi (content_type_id);
create index if not exists idx_poi_area    on kor_poi (area_code, sigungu_code);
create index if not exists idx_poi_raw_gin on kor_poi using gin (raw);

create table if not exists tats_cnctr (
  id          bigserial primary key,
  area_cd text, area_nm text, signgu_cd text, signgu_nm text,
  t_ats_nm text,
  base_ymd text,
  cnctr_rate double precision,
  raw jsonb not null,
  natural_key text not null unique,         -- signguCd:tAtsNm:baseYmd
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_tats_signgu on tats_cnctr (signgu_cd);
create index if not exists idx_tats_ymd    on tats_cnctr (base_ymd);

create table if not exists datalab_visitor (
  id          bigserial primary key,
  level text not null,                      -- 'metco'(시도) | 'locgo'(시군구)
  area_code text,
  signgu_code text,
  region_nm text,
  base_ymd text,
  daywk_div_cd text, daywk_div_nm text,
  tou_div_cd text, tou_div_nm text,
  tou_num double precision,
  raw jsonb not null,
  natural_key text not null unique,         -- level:region:baseYmd:touDivCd
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_dl_level on datalab_visitor (level, base_ymd);
create index if not exists idx_dl_region on datalab_visitor (level, area_code, signgu_code);

create table if not exists locgo_hub_tasks (
  id bigserial primary key,
  base_ym text not null, area_cd text not null, signgu_cd text not null, signgu_nm text,
  status text not null default 'pending',
  total_count integer, fetched integer not null default 0, attempts integer not null default 0,
  result_code text, error text, started_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (base_ym, signgu_cd)
);
create index if not exists idx_locgo_tasks_status on locgo_hub_tasks (status, base_ym desc, signgu_cd);

create table if not exists locgo_hub_records (
  id bigserial primary key,
  base_ym text not null,
  hub_tats_cd text not null, hub_tats_nm text,
  area_cd text, area_nm text, signgu_cd text, signgu_nm text,
  map_x double precision, map_y double precision,
  hub_ctgry_lcls_nm text, hub_ctgry_mcls_nm text, hub_rank integer,
  raw jsonb not null,
  natural_key text not null unique,         -- baseYm:signguCd:hubTatsCd
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_locgo_base_ym on locgo_hub_records (base_ym);
create index if not exists idx_locgo_signgu  on locgo_hub_records (base_ym, signgu_cd);
