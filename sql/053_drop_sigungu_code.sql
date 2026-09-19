-- 죽은 시군구 컬럼을 걷어낸다 — sigungu_code (관광공사 지역코드).
--
--  시군구가 두 벌로 저장돼 있었다:
--    · ldong_signgu_cd  법정동 코드. 서빙이 읽는 쪽 — ?sigungu= 필터 세 곳, 추천의 후보 풀,
--                       region_slugs 의 시·군 슬러그 21개(강릉·경주·여수·제주시·종로…)가 전부
--                       이걸로 좁힌다. 10,287행 중 누락 1건. **남긴다.**
--    · sigungu_code     관광공사 지역기반 코드. 수집 세 곳이 저장만 하고 src/server 어디서도
--                       읽지 않는다. barrier_free 55% · kor_poi 59% · pet_tour_poi 94% 가 비어
--                       있었는데 아무 일도 없었던 이유다. **이걸 뺀다.**
--
-- ⚠️ **ldong_signgu_cd 는 건드리지 말 것.** 2026-09-19 실측: 시군구 없이 시·도로만 좁히면
--    강릉 추천 후보가 249 → 957곳이 되어 속초·삼척·횡성이 섞이고, 가평은 27 → 1,526곳이 되어
--    서울대공원이 들어온다. "필수가 아니다" 는 행에 값이 없어도 된다는 뜻이지, 컬럼이 없어도
--    된다는 뜻이 아니었다.
--
--  같은 어휘의 짝인 area_code 도 서빙에서 읽지 않는다(둘이 idx_poi_area 인덱스를 함께 탄다).
--  요청 범위가 시군구라 여기서는 두지 않았다 — 걷어낼 거면 같은 방식이다.
--
--  drop column 은 의존 인덱스(kor_poi.idx_poi_area)를 함께 지운다. 그 인덱스는 어떤 쿼리도
--  타지 않는다. migrate 는 내용 해시로 재적용을 판단하므로 이 파일은 멱등이어야 한다.

alter table barrier_free  drop column if exists sigungu_code;
alter table kor_poi       drop column if exists sigungu_code;
alter table pet_tour_poi  drop column if exists sigungu_code;
