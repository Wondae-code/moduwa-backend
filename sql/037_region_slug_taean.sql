-- 앱의 지역 12종 중 유일하게 슬러그가 없던 태안을 채운다.
--
--  앱은 "가평·양평"처럼 묶인 지역을 대표 도시 슬러그로 보낸다(가평·강릉·춘천·안동·통영).
--  태안만 대응이 없어 추천 코스를 부를 수 없었다 — 광역(chungnam)으로 대신하면 서산·공주까지
--  섞여 "태안 여행"이 아니게 된다.
--
--  034 의 규칙대로 **후보 수를 세어 보고** 넣는다(2026-08-23 측정):
--    태안 44/825 — 사진 보유 51곳(관광지 33 · 음식점 5 · 숙소 5)
--  이미 들어 있는 안동(49곳)과 비슷한 규모다. 음식점이 5곳뿐이라 식사 슬롯은
--  thin_pool 로 비거나 반복될 수 있는데, 그건 응답의 notes 로 앱이 안내한다.
insert into region_slugs (slug, regn_cd, signgu_cd, label) values
  ('taean', '44', '825', '태안')
on conflict (slug) do update
  set regn_cd = excluded.regn_cd, signgu_cd = excluded.signgu_cd, label = excluded.label;
