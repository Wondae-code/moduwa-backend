-- 리뷰 댓글 — iOS 리뷰 상세의 댓글 목록·입력.
--  지금까지 앱은 댓글을 **더미 + 로컬 입력**으로만 다뤘다(서버에 테이블이 없었다).
--  작성자 식별은 리뷰와 같은 방식이다: 로그인 없이 기기 UUID + 닉네임 → authors 대리키.
--  (017 주석 참고. device_id 는 여기서도 응답에 절대 내보내지 않는다)

create table if not exists review_comments (
  id         bigserial primary key,
  review_id  bigint not null references reviews(id) on delete cascade,
  -- 댓글은 항상 쓰기 API 를 거쳐 만들어지므로 작성자가 반드시 있다(리뷰의 author_nm 같은
  -- 레거시 표시용 컬럼이 필요 없다 — 닉네임은 authors 조인으로 읽는다).
  author_id  bigint not null references authors(id) on delete cascade,
  body       text   not null,
  created_at timestamptz not null default now()
);

-- 리뷰별 댓글을 오래된 순으로 읽는다(대화 순서). 목록 조회의 유일한 접근 경로다.
create index if not exists idx_review_comments_review on review_comments (review_id, created_at);

-- ── 시연 시드 ────────────────────────────────────────────────────────────────
--  리뷰 상세를 열었을 때 댓글이 보여야 한다. 기존 시드 작성자 7명이 서로의 후기에 단 것으로 꾸민다.
--  '하은'과 '유나'의 후기에는 일부러 댓글을 달지 않는다 — 빈 상태("아직 댓글이 없어요")도
--  실제로 노출되어야 확인할 수 있다. (더미 생성기가 40%를 빈 목록으로 두던 의도를 옮겨 온다)
--
--  비어 있을 때만 심는다. 사용자가 실제로 댓글을 달기 시작한 뒤 migrate 를 재실행해도
--  시드가 다시 끼어들지 않는다.
insert into review_comments (review_id, author_id, body, created_at)
select r.id, a.id, v.body, now() - v.ago::interval
  from (values
    ('민지', '도현', '저도 지난달에 다녀왔어요. 데크가 넓어서 휠체어로도 편했습니다.',            '2 day'),
    ('민지', '서연', '주차장에서 산책로 입구까지도 평탄한가요? 부모님 모시고 가려고요.',          '1 day'),
    ('도현', '민지', '실내라 비 오는 날에도 좋겠네요. 정보 감사합니다!',                          '3 day'),
    ('도현', '준호', '음성 안내가 있다니 반갑네요. 시각장애인 동반 방문에 참고하겠습니다.',       '2 day'),
    ('도현', '하은', '엘리베이터 위치가 찾기 쉬운 편이었나요?',                                   '5 hour'),
    ('서연', '지우', '전동카트는 현장에서 바로 대여되나요?',                                      '4 day'),
    ('준호', '유나', '무장애 객실 예약이 따로 있는지 궁금합니다.',                                '6 day'),
    ('준호', '민지', '욕실 손잡이까지 챙겨 보신 후기라 도움이 많이 됐어요.',                      '12 hour'),
    ('지우', '서연', '로비까지 단차가 없다는 정보 정말 유용해요. 감사합니다.',                    '3 hour')
  ) as v(review_author, comment_author, body, ago)
  join reviews r on r.author_nm = v.review_author
  join authors a on a.nickname  = v.comment_author
 where not exists (select 1 from review_comments);

-- reviews.comment_count 를 실제 댓글 수로 맞춘다.
--  이 컬럼은 목록 응답과 '추천순' 정렬이 읽는 값이라 유지하되(조회마다 세지 않기 위해),
--  쓰기 라우트가 같은 트랜잭션에서 함께 증가시킨다.
--  ⚠️ 시드가 갖고 있던 값(7·15·4·23·9·18·3)은 근거 없는 숫자였다. 실제 댓글 수로 덮는다 —
--     화면에 "댓글 23"이 뜨는데 목록에는 2건만 나오는 상태를 만들지 않는다.
--  이 update 는 멱등이므로 migrate 재실행이 카운터 드리프트를 복구하는 안전망이 된다.
update reviews r
   set comment_count = (select count(*) from review_comments c where c.review_id = r.id);
