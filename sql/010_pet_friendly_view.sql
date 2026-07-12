-- 반려동물 통합 뷰 — content_id 하나로 3개 데이터를 결합
--  ① pet_tour_poi     : 반려동물 동반 가능 관광지(기본정보) — 이 뷰의 모든 행은 정의상 반려동물 동반 가능
--  ② pet_tour_detail  : 반려동물 전용 상세(동반유형·동반가능동물·필요사항)   [일반 반려견]
--  ③ kor_with_detail  : 무장애 helpdog(안내견/보조견 동반)                    [장애인 보조견 — 별개 개념]
--  + kor_detail(개요·운영시간) 참고 결합
create or replace view pet_friendly_view as
select
  p.contentid,
  p.title,
  p.contenttypeid,
  p.addr1,
  p.addr2,
  p.tel,
  p.mapx,
  p.mapy,
  p.firstimage,
  p.firstimage2,
  p.ldong_regn_cd,
  p.ldong_signgu_cd,
  -- ② 반려동물 동반 (일반 반려견)
  true                                       as pet_allowed,        -- 이 뷰의 모든 행은 반려동물 동반 서비스 소속
  d.acmpy_type_cd                            as pet_area,           -- 전구역/일부구역 동반가능
  d.acmpy_psbl_cpam                          as pet_species,        -- 동반 가능 동물
  d.acmpy_need_mtr                           as pet_need,           -- 동반 시 필요사항
  d.etc_acmpy_info                           as pet_etc,            -- 기타 동반정보
  -- ③ 안내견/보조견 동반 (무장애, 장애인 보조견 — 반려동물과 다른 개념)
  nullif(w.helpdog, '')                      as guide_dog_raw,
  (w.helpdog is not null and w.helpdog <> '') as guide_dog_allowed,
  -- 참고: 관광 소개/운영시간(KorService2 상세)
  kd.overview                                as overview,
  kd.intro_raw->>'usetime'                   as usetime
from pet_tour_poi p
left join pet_tour_detail d on d.contentid   = p.contentid
left join kor_with_detail w on w.content_id  = p.contentid
left join kor_detail      kd on kd.content_id = p.contentid;
