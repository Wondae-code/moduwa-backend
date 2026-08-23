-- 무장애 장소에 **신분류체계 코드**(lclsSystm1/2/3)를 실어 준다.
--
--  AI 추천 코스 명세 2-1(가격대 → 숙박 분류코드 매핑)의 전제다. 가격대 배지를 붙이려면
--  "이 숙소가 호텔인가 모텔인가 펜션인가"를 알아야 하는데, barrier_free 에는 contenttypeid
--  (32=숙박)까지만 있어 숙박 안에서의 구분이 불가능했다.
--
--  ⚠️ **새로 수집하는 것이 아니다.** kor_poi 가 이미 100% 채워 갖고 있었다(10,265/10,265).
--     파생 테이블인 barrier_free 로 전달만 되지 않던 것이다. 그래서 API 재수집이 필요 없다.
--
--  ── 왜 cat1/2/3(구 분류체계)은 가져오지 않나
--     같은 kor_poi 에 있지만 채움률이 50%(5,139/10,265)에 그친다. 반쯤 빈 컬럼을 나란히 두면
--     누군가 그걸로 필터를 걸었을 때 **절반이 조용히 사라진다.** 필요해지면 그때 추가한다.
--
--  ── 숙박(contenttypeid=32) 실측 분포 — 명세 2-1 매핑표의 근거
--     AC010100 호텔     458 | AC040100 모텔      190 | AC030100 펜션        132
--     AC030200 한옥·민박  75 | AC060200 게스트하우스 73 | VE050200 리조트       64
--     AC020100 콘도·가족호텔 36 | AC060100 유스호스텔  24 | AC020200 레지던스      7
--     AC030400  6 | AC030300  2 | VE100200 청소년수련원  2 ← 명세가 매핑 제외로 지정
--     ※ 리조트가 AC 가 아니라 VE05(휴양) 아래인 점에 주의. 숙박 매핑을 lcls_systm1='AC'
--       로 좁히면 리조트 64곳이 통째로 빠진다.
--
--  migrate 는 내용 해시로 재적용을 판단하므로 이 파일은 멱등이어야 한다.

alter table barrier_free add column if not exists lcls_systm1 text;
alter table barrier_free add column if not exists lcls_systm2 text;
alter table barrier_free add column if not exists lcls_systm3 text;

-- 추천 엔진이 "이 지역의 이 등급 숙소" 를 뽑는 경로. 소분류 단독보다 유형과 함께 걸린다.
create index if not exists idx_bf_lcls3 on barrier_free (contenttypeid, lcls_systm3);

-- 기존 행 백필. ingest:barrier-free 가 돌면 어차피 채워지지만, 그 전에도 바로 쓸 수 있게 한다.
--  (수집기를 못 돌리는 환경에서 마이그레이션만으로 스키마와 데이터가 맞아떨어져야 한다)
update barrier_free b
   set lcls_systm1 = p.lcls_systm1, lcls_systm2 = p.lcls_systm2, lcls_systm3 = p.lcls_systm3
  from kor_poi p
 where p.content_id = b.contentid and p.service = 'korwith'
   and b.lcls_systm3 is distinct from p.lcls_systm3;
