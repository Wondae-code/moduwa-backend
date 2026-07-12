-- 여행자 리뷰 — TourAPI엔 없는 자체 데이터. 홈 피드 '여행자 리뷰' 섹션용.
--  현재는 읽기(GET)만. 쓰기(POST)는 사용자 인증 체계 확정 후.
--  ⚠️ 쓰기 도입 전까지는 아래 시드가 소스. 쓰기가 생기면 관리형이 소스가 되므로
--     push-data.sh 의 파괴적 동기화 대상에서 reviews 를 반드시 제외할 것.
create table if not exists reviews (
  id            bigserial primary key,
  content_id    text,            -- kor_poi/barrier_free 참조(자유 방문지면 null)
  location_nm   text not null,   -- 표시용 장소명
  author_nm     text not null,
  body          text not null,
  like_count    int  not null default 0,
  comment_count int  not null default 0,
  is_accessibility_verified boolean not null default false,  -- ♿ 검증 뱃지
  created_at    timestamptz not null default now()
);
create index if not exists idx_reviews_created on reviews (created_at desc);
create index if not exists idx_reviews_content on reviews (content_id);
create index if not exists idx_reviews_reco on reviews ((like_count + comment_count) desc);

-- 시연용 시드 (중복 방지: 비어 있을 때만)
insert into reviews (content_id, location_nm, author_nm, body, like_count, comment_count, is_accessibility_verified, created_at)
select * from (values
  ('1019041','서울 와룡공원','민지','반려견과 산책하기 좋아요. 전 구역 동반 가능하고 경사가 완만해 휠체어로도 편했습니다.', 42, 7, true,  now() - interval '2 hour'),
  (null,     '강릉 안목해변','도현','바다 바로 앞까지 평탄한 데크가 이어져 유모차 끌기 편했어요. 카페거리도 접근성 좋음.',        88, 15, true,  now() - interval '1 day'),
  (null,     '제주 9.81 파크','서연','레포츠라 접근성은 제한적이지만 직원분들이 안내를 잘 해주셨어요. 반려견 동반 OK.',       31, 4, false, now() - interval '3 day'),
  (null,     '경복궁','준호','고궁이라 바닥이 고르진 않지만 주요 동선에 경사로가 있어 휠체어 관람 가능했습니다.',              120, 23, true,  now() - interval '5 day'),
  (null,     '부산 구포시장','하은','전통시장인데 안내견 동반 가능 표시가 있어 좋았어요. 통로가 좁은 구간은 주의.',          54, 9, false, now() - interval '8 day'),
  (null,     '순천만 국가정원','지우','장애인 주차장과 무장애 화장실이 잘 갖춰져 있고 전동카트도 있어 하루 종일 편하게 봤어요.', 96, 18, true,  now() - interval '12 day'),
  (null,     '전주 한옥마을','유나','골목이 많아 이동이 조금 번거로웠지만 반려견과 함께라 즐거웠습니다. 포토존 추천!',        27, 3, false, now() - interval '20 day')
) as v(content_id, location_nm, author_nm, body, like_count, comment_count, is_accessibility_verified, created_at)
where not exists (select 1 from reviews);
