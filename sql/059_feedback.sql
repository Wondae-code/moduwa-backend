-- 피드백 — 앱에서 보내는 의견·오류·정보 정정(docs/FEEDBACK.md).
--
--  **로그인하지 않아도 보낼 수 있다.** 그래서 author_id 가 비어도 된다. 로그인했으면 세션의
--  계정이 들어가고, 아니면 device_id 만 남는다.
--
--  ⚠️ **device_id 는 신원이 아니다.** "같은 기기에서 온 피드백 묶어 보기" 에만 쓴다. 이 값으로
--     "내 피드백 보기"·수정·삭제를 열면 남의 deviceId 를 실어 그 사람이 되는 구멍이 다시 열린다
--     (accounts.ts 상단). 어떤 응답에도 내보내지 않는다(017 규칙).
--
--  ⚠️ category 를 CHECK 로 고정하지 않는다(047 의 reason 과 같은 판단). 카테고리를 늘릴 때 서버
--     배포를 기다리지 않게 하려는 것이고, 대신 라우트가 화이트리스트로 막는다.
--
--  ⚠️ target_id 에 FK 를 걸지 않는다. 대상이 장소(contentid)·플랜(uuid) 둘이라 하나로 묶을 수
--     없고, 그 사이 플랜이 지워졌다고 피드백까지 사라지면 제보를 잃는다.
--
--  ⚠️ client 는 앱이 보낸 기기 정보 객체를 **그대로** 담는다. 키별로 검사하지 않아 앱이 항목을
--     늘려도 서버를 고치지 않는다. 크기 상한은 라우트가 막는다.
--
--  ⚠️ **탈퇴해도 FK 연쇄 삭제가 돌지 않는다.** 탈퇴는 authors 행을 지우지 않고 익명화한다
--     (auth-routes.ts 의 DELETE /me). 그래서 그 라우트가 피드백을 직접 지운다.
--     on delete cascade 는 authors 행이 실제로 지워지는 경우를 위한 것이다.
--
--  보관 기간은 접수 후 1년이다. 지나면 서버가 지운다(feedback.ts 의 purgeExpiredFeedback).
--
--  migrate 는 내용 해시로 재적용을 판단하므로 이 파일은 멱등이어야 한다.

create table if not exists feedback (
  id          bigserial primary key,
  author_id   bigint references authors(id) on delete cascade,
  device_id   text,
  -- inquiry | place | plan (라우트가 화이트리스트로 막는다)
  category    text   not null,
  -- place → contentid, plan → plans.id. inquiry 는 비운다.
  target_id   text,
  body        text   not null,
  reply_email text,
  client      jsonb,
  -- new → answered → closed (운영 화면에서 바꾼다)
  status      text   not null default 'new',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 운영 화면의 기본 목록 — 최근 것부터.
create index if not exists idx_feedback_created on feedback (created_at desc);
-- 아직 처리하지 않은 것만 훑는 경로(탭 배지).
create index if not exists idx_feedback_open on feedback (created_at desc) where status = 'new';
-- "이 계정·기기에서 온 다른 피드백" 과 탈퇴 시 삭제.
create index if not exists idx_feedback_author on feedback (author_id) where author_id is not null;
create index if not exists idx_feedback_device on feedback (device_id) where device_id is not null;
