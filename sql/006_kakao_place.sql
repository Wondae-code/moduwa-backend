-- 카카오 로컬(키워드 장소검색)로 보완한 장소 정보 — content_id당 1행.
-- TourAPI POI(이름+좌표)를 카카오에 질의해 전화·카테고리·카카오맵 링크를 빠르게 채움.
-- ⚠️ 영업시간은 카카오 API에 없음(웹페이지만) → place_url 링크로 대체.
-- 매칭은 이름+좌표 fuzzy → distance(우리 좌표와의 거리, m)와 matched 플래그로 품질 판단.
create table if not exists kakao_place (
  content_id          text primary key,    -- TourAPI contentid (kor_poi와 조인)
  kakao_id            text,
  place_name          text,
  category_name       text,                -- 예: "음식점 > 한식 > 국밥"
  category_group_code text,
  category_group_name text,
  phone               text,
  address_name        text,
  road_address_name   text,
  kakao_x             double precision,    -- 경도
  kakao_y             double precision,    -- 위도
  place_url           text,                -- 카카오맵 장소 상세 링크
  distance            double precision,    -- 우리 POI 좌표와의 거리(m)
  matched             boolean not null default false,
  raw                 jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists idx_kakao_matched on kakao_place (matched);
create index if not exists idx_kakao_group on kakao_place (category_group_code);
