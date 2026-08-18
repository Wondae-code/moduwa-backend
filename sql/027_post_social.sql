-- 게시글의 좋아요·댓글·무장애 정보 — 시안 "여행 후기 - 글쓰기"의 "무장애 정보 추가"(652:3429)와
--  게시글 상세(리뷰 상세 318:2 를 따라 만든 화면)의 좋아요·댓글.

-- ── 좋아요 ───────────────────────────────────────────────────────────────────
--  reviews.like_count 처럼 **숫자만** 두지 않는다. 그러면 "내가 이미 눌렀는지"를 알 수 없어
--  버튼이 눌린 상태를 그릴 수 없고, 한 사람이 여러 번 누르는 것도 막지 못한다.
--  누가 눌렀는지를 행으로 남기고 개수는 셈으로 얻는다.
create table if not exists post_likes (
  post_id    uuid   not null references posts(id) on delete cascade,
  author_id  bigint not null references authors(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, author_id)
);

-- "이 글의 좋아요 수"와 "내가 눌렀나" 두 질문에 같은 인덱스가 쓰인다(PK 선두가 post_id).
create index if not exists post_likes_author_idx on post_likes (author_id);

-- ── 댓글 ─────────────────────────────────────────────────────────────────────
--  리뷰 댓글(review_comments)과 같은 모양이다. 한 테이블에 합치지 않은 이유는 대상이 다르고
--  (review_id vs post_id) 어느 한쪽만 nullable 로 두면 두 화면이 서로의 null 을 걸러내야 한다.
create table if not exists post_comments (
  id         bigserial primary key,
  post_id    uuid   not null references posts(id) on delete cascade,
  author_id  bigint not null references authors(id) on delete cascade,
  body       text   not null,
  created_at timestamptz not null default now()
);

-- 글별 댓글을 오래된 순으로 읽는다(대화 순서).
create index if not exists post_comments_post_idx on post_comments (post_id, created_at);

-- ── 무장애 정보 ──────────────────────────────────────────────────────────────
--  작성 화면의 라임 캡슐("무장애 정보 추가")이 담는 값. 어떤 접근성 특성이 좋았는지 고른다.
--
--  코드는 앱의 `AccessibilityFeature` rawValue 를 그대로 쓴다(wheelchairAccessible,
--  hearingFriendly, visuallyImpairedFriendly, elderlyFriendly, childFriendly …).
--  ⚠️ DB 에서 값을 검증하지 않는다 — 앱이 아이콘을 늘리면 서버 마이그레이션 없이 따라가야 하고,
--  모르는 코드는 앱이 뱃지를 안 그리면 그만이다(plans.themes 와 같은 판단).
alter table posts add column if not exists access_features text[] not null default '{}';

-- 무장애 정보를 담은 글만 모아 보는 요청이 생길 수 있다(공모전 핵심 주제다).
create index if not exists posts_access_idx on posts using gin (access_features);
