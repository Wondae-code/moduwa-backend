-- 여행자 리뷰 → 방문한 장소 연결 (iOS '리뷰 상세'의 '방문한 장소' 카드용)
--
--  012 시드의 리뷰 7건 중 6건은 content_id 가 null 이었다. 리뷰 상세에서
--  '방문한 장소' 카드가 실제 장소 상세로 이어지도록 각 리뷰를 실제 장소(contentId)에 연결한다.
--
--  연결 대상은 앱 홈피드(HomeFeed.json = barrier_free 파생)에도 존재하는 장소만 골랐다.
--   → 온라인(/v1/barrier-free/:id) 뿐 아니라 오프라인 번들 폴백에서도 상세가 뜬다.
--  location_nm / body 도 연결 장소에 맞춰 정리한다(기존 문구는 전통시장·고궁 등 특정 장소를
--  가정하고 있어 링크 장소와 어긋나므로).
--
--  ⚠️ reviews 는 여전히 '시드가 소스'다. push-data.sh 파괴적 동기화 대상에서 제외할 것(012 참고).
--  author_nm 키로 UPDATE 하므로 반복 실행해도 안전(idempotent).

update reviews set content_id = '2033464', location_nm = '정남진 편백숲 우드랜드',
  body = '편백숲 산책로가 완만하고 데크가 잘 놓여 있어 휠체어로도 편하게 둘러봤어요. 반려견 동반도 가능합니다.'
  where author_nm = '민지';

update reviews set content_id = '2465063', location_nm = '강릉 녹색도시체험센터',
  body = '실내 전시라 휠체어로 전 구역 이동이 편했고, 음성 안내가 잘 되어 있어 부모님과 천천히 둘러봤습니다.'
  where author_nm = '도현';

update reviews set content_id = '2820546', location_nm = '무릉별유천지',
  body = '전동카트가 있어 이동이 수월했고, 장애인 주차장과 무장애 화장실도 잘 갖춰져 있어 하루 종일 편했어요.'
  where author_nm = '서연';

update reviews set content_id = '143025', location_nm = '롯데호텔 제주',
  body = '무장애 객실이 넓고 욕실 손잡이가 잘 되어 있어 편했습니다. 직원분들도 친절하게 안내해주셨어요.'
  where author_nm = '준호';

update reviews set content_id = '986600', location_nm = '이비스 앰배서더 수원',
  body = '입구 경사로와 엘리베이터가 잘 되어 있어 휠체어로 체크인까지 무리 없었어요.'
  where author_nm = '하은';

update reviews set content_id = '979885', location_nm = '무창포 비체팰리스',
  body = '객실 문턱이 없고 로비까지 평탄해서 이동이 편했어요. 바다 전망도 좋았습니다.'
  where author_nm = '지우';

update reviews set content_id = '990208', location_nm = '롯데시티호텔 마포',
  body = '역과 가깝고 입구부터 로비까지 단차가 없어 좋았어요. 무장애 객실도 깔끔합니다.'
  where author_nm = '유나';
