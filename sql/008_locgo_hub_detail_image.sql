-- 지역 대표 관광지 상세에 TourAPI 대표사진 추가 (무료·이미 수집된 common_raw 재사용)
--  firstimage : 대표이미지(원본), firstimage2 : 썸네일
--  image_copyright : cpyrhtDivCd (Type1=출처표시+변경금지, Type3=출처표시 등) — 표시 조건 준수용
alter table locgo_hub_detail add column if not exists firstimage      text;
alter table locgo_hub_detail add column if not exists firstimage2     text;
alter table locgo_hub_detail add column if not exists image_copyright text;
