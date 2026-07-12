-- 지역별 관광 다양성 (AreaTarDivService) — 현재 제공기관 데이터 미개방(전 조합 0건).
-- 실제 응답 필드를 모르므로 raw(JSONB)로 무손실 캡처. 데이터 개방 시 자동 적재되며,
-- 이후 실제 필드를 보고 타입드 컬럼을 추가하면 됨.
create table if not exists area_tar_div (
  id          bigserial primary key,
  operation   text not null,            -- areaTouDivList | areaExpDivList | areaIntlDivList
  area_cd     text not null,
  base_ym     text not null,
  region_nm   text,
  raw         jsonb not null,
  natural_key text not null unique,      -- operation:areaCd:baseYm:sha1(item)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_atd_op on area_tar_div (operation, base_ym);
create index if not exists idx_atd_raw_gin on area_tar_div using gin (raw);
