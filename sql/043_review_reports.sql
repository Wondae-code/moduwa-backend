-- 후기 신고 — 사용자가 부적절한 후기를 알리는 통로.
--
--  앱 팀 요청(2026-08-31). 앱은 사유 시트까지 이미 만들어 두었고 라우트만 열리면 동작한다.
--
--  ⚠️ **신고가 후기를 감추지 않는다.** 처리는 운영 판단이고, 자동으로 숨기면
--     "신고 버튼이 남의 글을 지우는 도구" 가 된다. 이 테이블은 기록만 한다.
--
--  ⚠️ unique (review_id, author_id) — 같은 사람의 재신고는 새 행이 아니라 갱신이다.
--     좋아요와 같은 판단으로 라우트가 멱등하게 204 를 준다(두 번 눌렀다고 오류를 볼 이유가 없다).
--     이 제약이 없으면 한 사람이 같은 글을 수천 번 신고해 통계를 왜곡할 수 있다.
--
--  ⚠️ reason 을 CHECK 로 고정하지 않는다. 앱이 사유를 늘릴 때 서버 배포를 기다리게 하지 않으려는
--     것이고(accessFeatures·themes 와 같은 판단), 대신 라우트가 화이트리스트로 막는다 —
--     화면에 없는 사유가 통계에 섞이면 운영이 판단할 수 없기 때문이다.
--
--  migrate 는 내용 해시로 재적용을 판단하므로 이 파일은 멱등이어야 한다.

create table if not exists review_reports (
  id         bigserial primary key,
  review_id  bigint not null references reviews(id) on delete cascade,
  author_id  bigint not null references authors(id) on delete cascade,
  reason     text   not null,
  detail     text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (review_id, author_id)
);

-- 운영이 "신고가 많은 후기" 를 찾는 경로. 후기당 건수 집계가 주 용도다.
create index if not exists idx_review_reports_review on review_reports (review_id);
