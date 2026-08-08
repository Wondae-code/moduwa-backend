-- 리뷰 쓰기(POST /v1/reviews) 기반 — 작성자(authors) 테이블 + 별점(rating)
--
-- 피그마 '장소 상세 > 리뷰' 섹션이 요구하는 데이터를 받친다.
--   · 리뷰별: 별점(★1~5), 작성일, 본문, 좋아요 수, 사진(014의 image_urls)
--   · 작성자 표시: 닉네임 / Level N / N개의 리뷰
--   · 장소 단위 전체 평점: 평균 별점 + 총 후기 수  (GET /v1/reviews/summary)
--
-- ── 설계 의도: 왜 reviews 가 device_id 를 직접 들고 있지 않은가 ─────────────────
--  지금은 로그인이 없다. 작성자는 "기기 UUID(device_id) + 닉네임"으로만 식별한다.
--  나중에 실계정(소셜 로그인 등)으로 확장할 때는 authors 에 user_id / email / provider
--  컬럼만 추가하고, 기존 author 행을 그 계정에 연결(또는 병합)하면 끝나야 한다.
--  그래서 reviews 는 device_id 를 절대 직접 참조하지 않고, 불변 대리키(surrogate key)
--  authors.id 만 참조한다.
--    → 기기를 바꿔 device_id 가 새로 생기거나, 여러 기기가 한 계정으로 병합되어도
--      '리뷰 → 작성자' 관계는 authors.id 그대로라 마이그레이션이 필요 없다.
--    → device_id 를 여러 개 갖는 계정도 나중에 author_devices 테이블로 분리 가능하다.
--  ⚠️ device_id 는 사실상 신원 토큰(bearer identity)이다. 어떤 API 응답에도 넣지 말 것.
--
-- ⚠️ 운영 주의: 쓰기 API가 생긴 이후 authors / reviews 의 소스는 관리형(prod) DB다.
--    로컬 → prod 파괴적 동기화(scripts/push-data.sh) 대상에서 두 테이블 모두 제외되어 있다.
--    (012_reviews.sql 상단 경고 참고. 되돌리면 유저 작성 리뷰가 전부 소실된다.)
--
-- migrate 는 전체를 재실행하므로 이 파일은 전부 멱등이어야 한다.

-- ── 작성자 ────────────────────────────────────────────────────────────────────
create table if not exists authors (
  id         bigserial primary key,
  -- 기기 UUID. 로그인 도입 후에도 유지하되, 계정만 있는 작성자를 위해 null 허용.
  -- (Postgres unique 인덱스는 null 을 중복 허용하므로 시드 작성자처럼 기기가 없는 행도 공존 가능)
  device_id  text unique,
  nickname   text not null,
  created_at timestamptz not null default now()
);

-- ── 리뷰 확장 ─────────────────────────────────────────────────────────────────
-- rating: null 허용 = "별점 없는 리뷰"(레거시/텍스트 전용). 평균 계산에서 제외된다.
--         check 는 null 에 대해 unknown → 통과하므로 별도 조건 불필요.
alter table reviews add column if not exists rating smallint check (rating between 1 and 5);
-- author_id: 표시용 author_nm 과 별개인 정규화된 작성자 참조.
--            author_nm 은 레거시 표시용으로 남긴다(016 이 author_nm 을 키로 UPDATE 한다).
alter table reviews add column if not exists author_id bigint references authors(id);

-- 장소별 리뷰 목록(최신순) — GET /v1/reviews?contentId=...&sort=latest
create index if not exists idx_reviews_content_created on reviews (content_id, created_at desc);
-- 작성자별 리뷰 수 집계 — author.reviewCount / level 파생용
create index if not exists idx_reviews_author on reviews (author_id);

-- ── 기존 시드 7건 백필 ────────────────────────────────────────────────────────
-- 1) author_nm 별 authors 행 생성. 시드 작성자는 기기가 없으므로 device_id 는 null.
--    (device_id is null 조건으로 "시드 작성자"와 "같은 닉네임의 실제 유저"를 구분한다)
insert into authors (nickname)
select distinct r.author_nm
  from reviews r
 where r.author_id is null
   and not exists (
     select 1 from authors a where a.nickname = r.author_nm and a.device_id is null
   );

-- 2) 리뷰 → authors 연결 (이미 연결된 행은 건드리지 않음)
update reviews r
   set author_id = a.id
  from authors a
 where a.nickname = r.author_nm
   and a.device_id is null
   and r.author_id is null;

-- 3) 별점 백필 — 016 이 다시 쓴 본문 내용과 어울리는 값.
--    (016 이 먼저 적용되므로 이 시점 본문은 016 버전이다)
--    '전 구역 편했다 / 잘 갖춰져 있다' 계열은 5, '무리 없었다 / 깔끔하다' 정도의
--    담백한 만족은 4 로 둔다. rating is null 조건으로 멱등.
update reviews set rating = v.rating
from (values
  ('민지', 5),  -- 편백숲 데크가 완만해 휠체어로도 편했다 (강한 칭찬)
  ('도현', 5),  -- 실내 전시라 전 구역 이동 편함 + 음성 안내 (강한 칭찬)
  ('서연', 5),  -- 전동카트·장애인 주차장·무장애 화장실 다 갖춤 (강한 칭찬)
  ('준호', 5),  -- 무장애 객실 넓고 욕실 손잡이 잘 되어 있음 (강한 칭찬)
  ('하은', 4),  -- "무리 없었어요" — 문제는 없었다는 담백한 만족
  ('지우', 5),  -- 문턱 없고 로비까지 평탄 + 전망까지 좋음
  ('유나', 4)   -- "깔끔합니다" — 단차 없음 정도의 담백한 만족
) as v(author, rating)
where reviews.author_nm = v.author and reviews.rating is null;
