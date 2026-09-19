-- 죽은 시·도 컬럼을 걷어낸다 — area_code (관광공사 지역코드). 053 의 sigungu_code 와 한 짝이다.
--
--  POI 세 테이블(barrier_free · kor_poi · pet_tour_poi)에서만 뺀다. 수집이 저장만 하고
--  src/server 어디서도 읽지 않았고, 55~94% 가 비어 있었다. 서빙의 시·도 축은 ldong_regn_cd 다.
--
-- ⚠️ **datalab_visitor.area_code 는 건드리지 않는다.** 이름만 같고 출처가 다르다 —
--    한국관광데이터랩 방문자 통계의 지역코드이고, idx_dl_region(level, area_code, signgu_code)
--    이 걸려 있으며 natural_key 의 재료다. TourAPI 구코드와 무관하다.
--
--  API 원값은 kor_poi.raw 의 areacode 키에 그대로 남아 있어 되살릴 수 있다.
--  migrate 는 내용 해시로 재적용을 판단하므로 이 파일은 멱등이어야 한다.

alter table barrier_free  drop column if exists area_code;
alter table kor_poi       drop column if exists area_code;
alter table pet_tour_poi  drop column if exists area_code;
