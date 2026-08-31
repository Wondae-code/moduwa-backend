-- 발송 이력 — 중복 억제와 진단에 쓴다.
--
--  앱 팀 요청(2026-08-31) 5-3. "좋아요는 껐다 켜기를 반복할 수 있으니 (post_id, actor) 당
--  하루 1회 정도로 묶어 달라" 는 요구를 만족시키려면 **무엇을 언제 보냈는지** 알아야 한다.
--
--  ⚠️ 이 표는 "알림 목록"(5-4)이 아니다. 그쪽은 받는 사람이 읽는 화면이고 읽음 상태·페이지네이션이
--     필요하다. 여기는 발송 측 기록이라 목적이 다르다 — 5-4 를 열 때 이 표를 재활용하려 하면
--     읽음 상태가 없어 곤란해진다. 그때는 별도 표를 만드는 것이 맞다.
--
--  ⚠️ event_key 로 묶는다. 예: 'post_like:{postId}:{actorId}' — 같은 사람이 같은 글에
--     좋아요를 반복해도 창 안에서는 한 번만 보낸다. 댓글은 매번 보내야 하므로(대화다)
--     키에 댓글 id 를 넣어 항상 달라지게 한다.
--
--  migrate 는 내용 해시로 재적용을 판단하므로 이 파일은 멱등이어야 한다.

create table if not exists push_sends (
  id         bigserial primary key,
  -- 받는 사람. 계정이 지워지면 이력도 함께 지운다.
  author_id  bigint not null references authors(id) on delete cascade,
  event_key  text   not null,
  -- 발송 시도 결과. 실패 사유를 남겨 두면 BadDeviceToken 같은 설정 오류를 사후에 찾을 수 있다.
  ok         boolean not null,
  detail     text,
  created_at timestamptz not null default now()
);

-- 중복 억제 조회: "이 사람에게 이 키로 최근에 보냈나".
create index if not exists idx_push_sends_dedupe on push_sends (author_id, event_key, created_at desc);
