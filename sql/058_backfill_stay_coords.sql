-- 추천으로 만든 플랜의 숙소에 좌표를 채운다.
--
--  recommend 응답의 stay 가 { contentID, name, imageURL } 만 내보내고 있었다. 같은 응답의
--  days[].items 는 latitude·longitude 를 싣는데 숙소만 빠져서, 지도에 숙소 핀이 안 찍혔다.
--  plan_items 는 좌표를 **박제**하므로(021 주석: 원본 POI 가 사라져도 지난 여행은 그대로
--  보여야 한다) 서버를 고쳐도 이미 저장된 행은 null 로 남는다. 그래서 백필한다.
--
-- ── 실측 (2026-09-21 프로덕션)
--    좌표 없는 stop 행 51개 — **전부 category_label='숙소'**, content_id 14종,
--    전부 barrier_free 에 있고 그쪽 좌표는 하나도 비어 있지 않다. 남는 행 없이 채워진다.
--    (memo 행 3개도 좌표가 없지만 content_id 가 없다 — 메모에 좌표는 원래 없는 것이라 건드리지 않는다.)
--
-- ⚠️ **이미 값이 있는 행은 덮지 않는다.** stop 행 566개는 좌표를 갖고 있고 그중 7개는
--    barrier_free 와 0~0.3km 다르다. 앱이 /v1/search 등에서 받아 넣은 값일 수 있고,
--    박제의 뜻은 "그때 저장한 값을 지킨다" 이다. 덮으면 그 뜻이 깨진다.
--    `latitude is null` 조건이 그 방어이자 이 파일의 멱등성이다.
--
-- ⚠️ barrier_free 에 없는 content_id 는 그대로 둔다. 지금은 0건이지만 미조사 식당(039)이
--    숙소 자리에 올 일이 생기면 조용히 엉뚱한 좌표가 박히지 않게 join 으로 막아 둔다.

update plan_items i
   set latitude = b.mapy, longitude = b.mapx
  from barrier_free b
 where b.contentid = i.content_id
   and i.kind = 'stop'
   and i.latitude is null
   and i.content_id is not null
   and b.mapx is not null and b.mapy is not null;
