-- 여행 게시글 — 시안 "여행 후기 - 글쓰기"(642:2639).
--
--  후기(reviews)와 다른 것이다. 후기는 **장소에 대한 평가**(별점·태그·재방문)이고
--  게시글은 **여행 경험을 나누는 글**이다. reviews 에 kind 컬럼을 얹어 섞지 않는 이유:
--   ① 후기는 content_id 가 축이고 게시글은 여러 장소를 붙일 수 있다(1:N 이 다르다)
--   ② 후기의 rating/would_revisit/태그는 게시글에 뜻이 없어 전부 null 이 된다
--   ③ 장소 후기 화면과 게시글 목록은 정렬·집계가 다르다
--  섞어 놓으면 두 화면이 서로의 null 을 계속 걸러내야 한다.
create table if not exists posts (
  id         uuid primary key default gen_random_uuid(),
  author_id  bigint not null references authors(id) on delete cascade,
  body       text   not null,
  -- 업로드된 사진 URL. 저장소는 후기 사진과 같은 곳을 쓴다(내용 sha256 파일명이라
  -- 경로 접두사가 뜻을 갖지 않는다) — `POST /v1/reviews/images` 참고.
  image_urls text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 목록은 "최근 글부터", 내 글은 "내가 쓴 것 중 최근부터" 를 묻는다.
create index if not exists posts_recent_idx on posts (created_at desc);
create index if not exists posts_author_idx on posts (author_id, created_at desc);

-- 글에 붙인 장소. 순서가 있다(글에서 언급한 순서대로 붙는다).
--
--  ⚠️ 이름·지역을 **함께 박아 둔다**. content_id 만 두면 원본 POI 가 사라졌을 때
--  옛 글이 빈 줄을 보여 준다 — 플랜의 plan_items 가 장소를 박제하는 것과 같은 이유다.
--  FK 도 걸지 않는다(push-data.sh 가 barrier_free 를 통째로 갈아치운다).
create table if not exists post_places (
  post_id    uuid not null references posts(id) on delete cascade,
  position   int  not null,
  content_id text not null,
  place_name text not null,
  region     text,
  primary key (post_id, position)
);

create index if not exists post_places_content_idx on post_places (content_id);
