-- 저장한 장소(북마크) — 시안 "04. 저장 - 모아보기"(642:837).
--
--  장소 상세의 "저장하기"가 여기에 쌓이고, 저장 탭이 카테고리별로 묶어 보여 준다.
--
--  device_id 를 직접 참조하지 않고 authors 대리키를 쓴다 — 후기·플랜과 같은 규칙이다.
--  로그인이 붙으면(author_devices/signIn 이 이미 있다) 저장한 장소가 계정을 따라간다.
--  device_id 는 신원 토큰이라 이 테이블에도, API 응답에도 두지 않는다.
--
--  ⚠️ content_id 에 FK 를 걸지 않는다. push-data.sh 가 barrier_free 를 통째로 갈아치우므로
--  FK 가 있으면 동기화가 막힌다(related_places 와 같은 이유). 원본이 사라진 장소는
--  조회 시 join 에서 자연스럽게 빠진다.
create table if not exists saved_places (
  author_id  bigint not null references authors(id) on delete cascade,
  content_id text   not null,
  created_at timestamptz not null default now(),
  -- 같은 장소를 두 번 저장할 수 없다. "저장 취소 후 재저장"은 새 행이 되어 맨 앞으로 온다.
  primary key (author_id, content_id)
);

-- 저장 탭은 "내가 저장한 것, 최근 저장한 순"을 묻는다.
create index if not exists saved_places_author_idx on saved_places (author_id, created_at desc);
