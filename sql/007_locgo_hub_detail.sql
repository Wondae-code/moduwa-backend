-- 지역 대표 관광지(LocgoHubTarService1) 상세 — hub_tats_cd당 1행, 3단 폴백 집계
--  ① TourAPI 소개(개요·이용시간·홈페이지) : 이름 연결, 명소만 (이미 수집된 kor_detail 재사용)
--  ② 카카오 로컬(전화·카테고리·카카오맵 링크) : 좌표+이름 매칭, 키 있을 때
--  ③ 지도 딥링크(카카오/네이버) : 좌표만으로 100% 생성 — 최종 폴백
create table if not exists locgo_hub_detail (
  hub_tats_cd   text primary key,
  hub_tats_nm   text,
  area_cd       text,
  signgu_cd     text,
  map_x         double precision,   -- 경도
  map_y         double precision,   -- 위도
  map_url_kakao text,               -- ③ 항상 생성
  map_url_naver text,               -- ③ 항상 생성
  overview      text,               -- ① TourAPI 개요
  usetime       text,               -- ① TourAPI 이용시간
  homepage      text,               -- ① TourAPI 홈페이지
  phone         text,               -- ② 카카오 전화
  category      text,               -- ② 카카오 카테고리
  place_url     text,               -- ② 카카오맵 상세 링크
  detail_source text,               -- 가장 풍부한 소스: tourapi | kakao | map-only
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_lhd_signgu on locgo_hub_detail (signgu_cd);
create index if not exists idx_lhd_source on locgo_hub_detail (detail_source);
