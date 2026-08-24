-- 후기 좋아요 — 게시글 post_likes(027)와 같은 패턴.
--
--  A13(기획): 장소상세에서 남의 후기에 좋아요가 안 된다. 앱의 하트가 "표시 전용"이었던 건
--  이 라우트가 없어서다 — 누가 눌렀는지 담을 자리가 없으니 likedByMe 를 그릴 수도 없었다.
--
--  게시글과 한 가지 다르게 간다: reviews.like_count 컬럼을 **버리지 않고 그 위에 누적**한다.
--  시연용 시드(012)가 그 컬럼에 값을 갖고 있고(민지 761 등), '좋아요 순' 정렬 인덱스
--  (idx_reviews_reco)도 그 컬럼을 쓴다. review_likes 를 진실로 삼아 컬럼을 0 부터 다시 세면
--  시드 좋아요가 통째로 사라지고 정렬 인덱스도 못 쓴다. 그래서 like_count 는 캐시로 두고
--  좋아요/취소가 **실제로 일어났을 때만** ±1 한다(review_comments 가 comment_count 를
--  올리는 것과 같은 방식).
create table if not exists review_likes (
  review_id  bigint      not null references reviews(id) on delete cascade,
  author_id  bigint      not null references authors(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (review_id, author_id)
);

-- "내가 좋아요한 후기"를 물을 때 쓴다(저장 탭이 게시글에서 하는 것과 같은 축).
create index if not exists review_likes_author_idx on review_likes (author_id);
