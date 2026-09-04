-- 관광식당 (행안부 식품_관광식당 조회서비스, /1741000/tourist_restaurants)
--
--  관광진흥법상 **지정업소**다. 규모는 작지만(영업중 142곳) 기존 데이터와 겹치는 것이 13% 뿐이고,
--  "관광식당 지정" 은 우리가 만들 수 없는 품질 신호다.
--
-- ⚠️ **API 가 사업장이 아니라 갱신 이력을 준다.** 526 레코드가 사업장 218곳이다(MNG_NO 중복).
--    그래서 PK 는 MNG_NO 이고, 수집 스크립트가 사업장별 최신 레코드만 골라 upsert 한다.
--    행 수를 업소 수로 세면 두 배 넘게 부풀려진다.
--
-- ⚠️ **폐업 업소도 남긴다.** 218곳 중 76곳이 폐업/기타다. 지우지 않고 sales_status 로 남기는
--    이유는 두 가지다 — 재개업하면 같은 MNG_NO 로 돌아오고, 삭제하면 "왜 사라졌는지" 를
--    알 수 없다. **조회하는 쪽이 영업중만 걸러야 한다**(아래 뷰가 그 일을 한다).
--
-- ⚠️ **원본 좌표(CRD_INFO_X/Y)를 쓰지 않는다.** 투영좌표계인데 원점이 우리가 아는 어느 정의와도
--    맞지 않는다 — 카카오 지오코딩 40건과 대조해 ΔX 중앙 -72m / ΔY 중앙 -309m(표준편차 31/16m)
--    의 일정한 오프셋이 나왔다. 경험적 보정으로 쓸 수도 있지만 오차가 수십 미터 남는다.
--    그래서 주소를 카카오로 지오코딩해 WGS84 를 직접 얻는다(lat/lon). 원본 좌표는 raw 에만 둔다.
--
--  migrate 는 내용 해시로 재적용을 판단하므로 이 파일은 멱등이어야 한다.

create table if not exists tourist_restaurants (
  -- 사업장 관리번호(20자, 예: CDFI3261042026000001). 사업장 단위의 안정적인 식별자다.
  mng_no          text primary key,
  name            text not null,
  road_addr       text,
  lot_addr        text,
  zipcode         text,
  tel             text,
  -- 업종명. 지금은 전부 '관광식당업' 이지만 제공기관이 늘릴 수 있어 그대로 담는다.
  biz_type        text,
  -- '영업/정상' 등. 조회 시 이 값으로 거른다.
  sales_status    text,
  sales_status_detail text,
  closed_date     date,
  licensed_date   date,
  eng_name        text,
  facility_size   double precision,

  -- ── 지오코딩 결과(WGS84) ──
  --  ⚠️ null 일 수 있다. 주소가 특이해 카카오가 못 찾는 경우가 있어 **not null 로 두지 않는다** —
  --     좌표가 없어도 이름·주소·전화는 쓸 수 있고, 좌표를 강제하면 그 업소가 아예 빠진다.
  lat             double precision,
  lon             double precision,
  -- 어떤 질의로 찾았는지(road/lot/keyword). 나중에 품질을 되짚을 때 쓴다.
  geocode_source  text,
  -- 카카오가 실제로 매칭한 주소. 원본과 다르면 사람이 확인할 단서가 된다.
  geocode_matched text,
  geocoded_at     timestamptz,

  raw             jsonb not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- 지역별 조회(추천 엔진이 시군구로 후보를 좁힌다). 영업중만 담는 부분 인덱스다.
create index if not exists idx_tourist_rest_addr on tourist_restaurants (road_addr)
  where sales_status = '영업/정상' and closed_date is null;

-- 좌표 기반 근접 검색. 좌표가 없는 행은 인덱스에 넣지 않는다.
create index if not exists idx_tourist_rest_geo on tourist_restaurants (lat, lon)
  where lat is not null and lon is not null;

-- 조회하는 쪽이 매번 필터를 적는 것을 잊지 않게 뷰로 굳힌다.
--  ⚠️ 좌표가 없는 업소도 포함한다 — 좌표는 지도 표시에만 필요하고, 목록·검색에는 없어도 된다.
create or replace view tourist_restaurants_open as
  select mng_no, name, road_addr, lot_addr, zipcode, tel, biz_type,
         eng_name, facility_size, lat, lon, licensed_date
    from tourist_restaurants
   where sales_status = '영업/정상' and closed_date is null;

comment on table tourist_restaurants is
  '관광진흥법상 관광식당 지정업소(행안부). 폐업 포함 전량 보관 — 조회는 tourist_restaurants_open 뷰를 쓴다.';
comment on column tourist_restaurants.lat is
  '카카오 지오코딩으로 얻은 WGS84 위도. 원본 CRD_INFO_X/Y 는 원점 불일치로 쓰지 않는다(파일 상단 주석).';
