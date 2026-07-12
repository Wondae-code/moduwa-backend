-- 무장애(접근성) 장소 — kor_poi(service='korwith') ⨝ kor_with_detail 을 플랫 슬림 테이블로.
--  무거운 kor_poi(185MB, raw 포함)를 관리형에 올리지 않기 위한 슬림 사본 (locgo_hub_detail 패턴).
--  ingest:barrier-free 가 매일 갱신(upsert). API /v1/barrier-free 가 이 테이블만 읽는다.
create table if not exists barrier_free (
  contentid       text primary key,
  title           text,
  contenttypeid   text,
  addr1           text,
  addr2           text,
  mapx            double precision,
  mapy            double precision,
  firstimage      text,
  firstimage2     text,
  area_code       text,
  sigungu_code    text,
  ldong_regn_cd   text,
  ldong_signgu_cd text,
  -- 이동 편의(28속성 중 지체·이동 우선)
  parking text, route text, publictransport text, ticketoffice text, promotion text,
  wheelchair text, exit text, elevator text, restroom text, auditorium text, room text, handicapetc text,
  -- 시각
  braileblock text, helpdog text, guidehuman text, audioguide text, bigprint text, brailepromotion text,
  guidesystem text, blindhandicapetc text,
  -- 청각
  signguide text, videoguide text, hearingroom text, hearinghandicapetc text,
  -- 영유아·가족
  stroller text, lactationroom text, babysparechair text, infantsfamilyetc text,
  has_image       boolean not null default false,
  updated_at      timestamptz not null default now()
);
create index if not exists idx_bf_type    on barrier_free (contenttypeid);
create index if not exists idx_bf_sigungu on barrier_free (ldong_regn_cd, ldong_signgu_cd);
create index if not exists idx_bf_hasimage on barrier_free (has_image);
