-- 앱의 묶음 지역 네 곳을 실제 묶음으로 만든다 — 055 의 signgu_cds 를 쓴다.
--
--  앱은 "가평·양평" 처럼 두세 시군을 한 항목으로 보여 주는데, 슬러그는 대표 도시 하나만
--  가리키고 있었다. 묶음 이름으로 고르게 하면서 나머지를 빼고 추천한 셈이다.
--  055(포항·전주)와 같은 성질의 누락이고, 앱팀이 네 곳을 짚어 왔다.
--
-- ── 후보 수 (034 의 규칙대로 세고 넣는다, 2026-09-20 · 사진 보유 기준)
--     슬러그       대표 도시        더해지는 곳                합계
--     gapyeong    가평 27         양평 62                   89   ← 빠진 쪽이 두 배 이상 크다
--     gangneung   강릉 249        속초 71                   320
--     chuncheon   춘천 111        홍천 20                   131
--     tongyeong   통영 49         거제 64 · 남해 38          151   ← 대표 도시가 3분의 1 이다
--
-- ⚠️ **거리를 재 보고 넣는다.** 묶음은 후보를 늘리지만 하루 동선을 흩을 수 있고, 거리 감점은
--    min(30, km × 1.5) 라 20km 에서 포화해 그 너머를 구별하지 못한다. 다만 실측해 보니
--    묶음의 도시 간 거리(강릉↔속초 54km · 거제↔남해 64km)는 **지금 잘 도는 슬러그가 이미
--    혼자 감당하는 범위** 안이다 — 태안 혼자 대각선 64km, 강릉 50km, 안동 44km.
--    하루 동선도 재서 확인했다(아래 커밋 메시지 참고).
--
-- ⚠️ sokcho · geoje · namhae 슬러그는 **남긴다.** 앱은 묶음으로만 고르지만 이 슬러그들은
--    지금도 정상 동작하고, 지우면 그 이름으로 부르던 호출이 region_not_found 가 된다.
--    슬러그끼리 배타적일 이유가 없다 — 속초는 sokcho 로도, gangneung 묶음으로도 닿는다.
--
--  migrate 는 내용 해시로 재적용을 판단하므로 이 파일은 멱등이어야 한다.

update region_slugs set signgu_cds = array['820', '830'] where slug = 'gapyeong';   -- 가평군 · 양평군
update region_slugs set signgu_cds = array['150', '210'] where slug = 'gangneung';  -- 강릉시 · 속초시
update region_slugs set signgu_cds = array['110', '720'] where slug = 'chuncheon';  -- 춘천시 · 홍천군
update region_slugs set signgu_cds = array['220', '310', '840'] where slug = 'tongyeong'; -- 통영 · 거제 · 남해
