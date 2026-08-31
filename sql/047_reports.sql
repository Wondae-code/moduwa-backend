-- 신고 — 게시글·게시글 댓글·후기·후기 댓글을 한 테이블에 모은다.
--
--  앱 팀 요청(2026-08-31). 신고가 후기에만 있어서 앱의 대부분이 신고할 수 없는 상태였다.
--  사용자 생성 콘텐츠가 있는 앱은 앱 심사에서 신고 수단을 요구한다.
--
--  ⚠️ **테이블을 넷으로 나누지 않는다.** 대상이 넷인데 테이블을 넷 두면 운영에서 볼 곳도
--     넷이 되고, "신고가 많은 대상" 을 한 번에 볼 수 없다(앱 팀 지적). 043 의 review_reports
--     내용은 아래에서 이 표로 옮긴다.
--
--  ⚠️ **외래키를 걸지 않는다.** 대상 테이블이 넷이라 하나의 FK 로 묶을 수 없다. 대신 라우트가
--     대상 존재를 확인하고(없으면 404), 대상이 지워져도 신고 기록은 남는다 — "신고된 뒤
--     지워졌다" 는 운영에 필요한 사실이라 같이 지우지 않는다.
--
--  ⚠️ target_id 를 text 로 둔다. 게시글은 uuid 이고 나머지는 bigint 라 한 타입으로 담을 수
--     없다. 라우트가 형식을 검증하고(uuid / 정수) 문자열로 넣는다.
--
--  ⚠️ unique (target_type, target_id, author_id) — 같은 사람의 재신고는 새 행이 아니라
--     갱신이다. 라우트가 멱등하게 204 를 준다(좋아요와 같은 판단). 이 제약이 없으면 한 사람이
--     같은 글을 수천 번 신고해 통계를 왜곡할 수 있다.
--
--  ⚠️ reason 을 CHECK 로 고정하지 않는다(043 과 같은 판단). 앱이 사유를 늘릴 때 서버 배포를
--     기다리게 하지 않으려는 것이고, 대신 라우트가 화이트리스트로 막는다.
--
--  ⚠️ **신고가 대상을 감추지 않는다.** 043 에서 세운 원칙 그대로다. 자동으로 숨기면 신고
--     버튼이 남의 글을 지우는 도구가 된다. 이 표는 기록만 한다.
--
--  migrate 는 내용 해시로 재적용을 판단하므로 이 파일은 멱등이어야 한다.

create table if not exists reports (
  id          bigserial primary key,
  -- post | post_comment | review | review_comment (라우트가 화이트리스트로 막는다)
  target_type text   not null,
  target_id   text   not null,
  author_id   bigint not null references authors(id) on delete cascade,
  reason      text   not null,
  detail      text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (target_type, target_id, author_id)
);

-- 운영이 "신고가 많은 대상" 을 찾는 경로. 대상별 건수 집계가 주 용도다.
create index if not exists idx_reports_target on reports (target_type, target_id);
-- 최근 신고부터 훑는 경로(운영 화면의 기본 정렬).
create index if not exists idx_reports_created on reports (created_at desc);

-- 043 의 후기 신고를 옮긴다. 재실행해도 안전하다(on conflict do nothing).
--  review_reports 는 지우지 않는다 — 되돌릴 수 없는 작업이고, 이 표가 실제로 쓰이는 것을
--  확인한 뒤에 따로 정리하는 편이 안전하다. 라우트는 이제 reports 에만 쓴다.
insert into reports (target_type, target_id, author_id, reason, detail, created_at, updated_at)
select 'review', review_id::text, author_id, reason, detail, created_at, updated_at
  from review_reports
    on conflict (target_type, target_id, author_id) do nothing;
