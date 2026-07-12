-- 반려동물 동반여행 서비스 (KorPetTourService2) — content_id 체계 (KorService2와 동일 네임스페이스)
--  pet_tour_poi   : 목록(areaBasedList2) — 반려동물 동반 가능 관광지 기본정보
--  pet_tour_detail: 반려동물 전용 상세(detailPetTour2) — 동반유형·동반가능동물·필요사항 등

create table if not exists pet_tour_poi (
  contentid       text primary key,
  contenttypeid   text,
  title           text,
  addr1           text,
  addr2           text,
  tel             text,
  mapx            double precision,
  mapy            double precision,
  firstimage      text,
  firstimage2     text,
  cpyrht_div_cd   text,               -- 사진 저작권 유형(Type1/Type3)
  area_code       text,
  sigungu_code    text,
  ldong_regn_cd   text,               -- 법정동 시도(2자리)
  ldong_signgu_cd text,               -- 법정동 시군구(3자리)
  cat1 text, cat2 text, cat3 text,
  lcls_systm1 text, lcls_systm2 text, lcls_systm3 text,  -- 분류체계 대/중/소
  created_time    text,
  modified_time   text,
  raw             jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_pet_poi_sigungu on pet_tour_poi (ldong_regn_cd, ldong_signgu_cd);
create index if not exists idx_pet_poi_type    on pet_tour_poi (contenttypeid);

create table if not exists pet_tour_detail (
  contentid           text primary key,
  acmpy_type_cd       text,   -- 동반유형(동반구분): 예) 전구역 동반가능
  acmpy_psbl_cpam     text,   -- 동반가능동물: 예) 전 견종 동반 가능
  acmpy_need_mtr      text,   -- 동반시 필요사항: 예) 목줄 착용
  etc_acmpy_info      text,   -- 기타 동반정보
  rela_acdnt_risk_mtr text,   -- 관련 사고 대비사항
  rela_poses_fclty    text,   -- 관련 구비시설
  rela_frnsh_prdlst   text,   -- 관련 비치품목
  rela_purc_prdlst    text,   -- 관련 구매품목
  rela_rntl_prdlst    text,   -- 관련 렌탈품목
  raw                 jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
