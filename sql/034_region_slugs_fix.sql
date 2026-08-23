-- 지역 슬러그를 **실데이터 기준**으로 교정한다.
--
--  033 에서 표준 법정동 코드를 가정하고 시드했는데, barrier_free.ldong_regn_cd 는 TourAPI 가
--  주는 값이라 표준과 다른 데가 있었다. 검증해 보니 5개 슬러그가 후보 0건이었다 —
--  추천이 400 도 아니고 **빈 코스를 200 으로** 돌려주는 최악의 형태로 실패한다.
--
--  ── 실측으로 드러난 세 가지 예외
--   ① 세종: regn_cd 가 '36' 이 아니라 **'36110'** (regn·signgu 가 같은 5자리. 018 주석의 그 예외)
--   ② 전남·광주: TourAPI 가 2026년 통합을 반영해 **'12' 전남광주통합특별시** 로 합쳐 내려준다.
--      표준의 전남 46 · 광주 29 는 barrier_free 에 사실상 없다(29 는 2건).
--   ③ 전북 52, 전주는 signgu '110' 이 아니라 **'111'**
--
--  ⚠️ 슬러그를 새로 넣을 때는 **반드시 후보 수를 세어 보고** 넣을 것. 아래 쿼리로 검증한다:
--     select r.slug, (select count(*) from barrier_free b
--                      where b.ldong_regn_cd = r.regn_cd
--                        and (r.signgu_cd is null or b.ldong_signgu_cd = r.signgu_cd)
--                        and b.has_image)
--       from region_slugs r order by 2;

update region_slugs set regn_cd = '36110', signgu_cd = null where slug = 'sejong';
update region_slugs set regn_cd = '52', signgu_cd = '111'    where slug = 'jeonju';
update region_slugs set regn_cd = '12', signgu_cd = '130'    where slug = 'yeosu';
-- 전남·광주는 통합 코드 하나를 가리킨다. 라벨도 실제 데이터에 맞춘다.
update region_slugs set regn_cd = '12', signgu_cd = null, label = '전남·광주' where slug = 'jeonnam';
update region_slugs set regn_cd = '12', signgu_cd = null, label = '전남·광주' where slug = 'gwangju';

-- 후보가 넉넉히 확인된 곳만 추가한다(전부 사진 보유 30건 이상).
insert into region_slugs (slug, regn_cd, signgu_cd, label) values
  ('mokpo',   '12', '110', '목포'),
  ('suncheon','12', '150', '순천'),
  ('gunsan',  '52', '130', '군산'),
  ('namwon',  '52', '190', '남원'),
  ('buan',    '52', '800', '부안')
on conflict (slug) do nothing;
