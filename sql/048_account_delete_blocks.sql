-- 계정 삭제 · 사용자 차단 — 앱스토어 심사 필수 항목(앱 팀 요청 2026-09-01).
--
--  5.1.1(v) 계정을 만들 수 있는 앱은 앱 안에서 계정 삭제도 제공해야 한다.
--  1.2      사용자 생성 콘텐츠 앱은 신고·차단·필터·연락처를 모두 갖춰야 한다.
--
--  migrate 는 내용 해시로 재적용을 판단하므로 이 파일은 멱등이어야 한다.

-- ── 탈퇴 표시 ────────────────────────────────────────────────────────────────
--  ⚠️ **행을 지우지 않고 익명화한다**(앱 팀·기획 결정). 함께 쓴 대화가 통째로 사라지면 남은
--     사람의 화면이 깨진다 — 답글만 남은 스레드, 멤버가 사라진 공유 플랜, 후기 수가 줄어드는
--     장소. 지운 사람이 아니라 남은 사람이 손해를 본다. 개인정보(이메일·비밀번호·사진·닉네임)와
--     접근 수단(신원·세션·기기 토큰)은 전부 지우므로 "데이터 삭제" 요건은 충족한다.
--
--  ⚠️ 이 컬럼은 "지워진 계정" 표시일 뿐 로그인을 막는 장치가 아니다. 로그인을 막는 것은
--     author_identities 행을 지우는 것이다 — 신원이 없으면 어떤 방법으로도 이 계정에 닿지 못한다.
alter table authors add column if not exists deleted_at timestamptz;

comment on column authors.deleted_at is
  '탈퇴 시각. 닉네임은 탈퇴한 사용자 로 바뀌고 이메일·사진·신원·세션은 지워진다. 콘텐츠는 남는다.';

-- ── 애플 refresh token ──────────────────────────────────────────────────────
--  ⚠️ **애플 로그인을 제공하는 앱은 계정 삭제 시 애플에 토큰 폐기를 요청해야 한다**(심사 규칙).
--     폐기 요청에는 애플이 로그인 때 준 refresh token 이 필요한데, 지금까지는 ID 토큰만 검증하고
--     버렸다. 그래서 저장할 자리를 만든다.
--
--  ⚠️ provider='apple' 행에만 값이 있다. 다른 provider 는 null 이다.
--  ⚠️ 폐기에 쓰고 나면 신원 행과 함께 지워진다 — 계정 삭제 뒤에 남을 값이 아니다.
alter table author_identities add column if not exists refresh_token text;

comment on column author_identities.refresh_token is
  '애플이 로그인 때 준 refresh token. 계정 삭제 시 appleid.apple.com/auth/revoke 에 쓴다.';

-- ── 차단 ─────────────────────────────────────────────────────────────────────
--  ⚠️ **단방향이다.** blocker 가 blocked 를 가린다. 반대 방향은 영향이 없다 — 차단당한 사람의
--     화면에서 내 글이 사라지지는 않는다(앱 팀 결정). 대신 그 사람은 내 글에 새 댓글을 달 수
--     없다(403). 가리기만 하면 차단해도 댓글은 계속 달리고 알림만 막힌 상태가 된다.
--
--  ⚠️ PK 가 (blocker, blocked) 라 재차단은 새 행이 아니다 — 라우트가 멱등하게 204 를 준다.
--  ⚠️ check 로 자기 차단을 막는다. 자기를 차단하면 내 글이 내 목록에서 사라진다.
create table if not exists blocks (
  blocker_id bigint not null references authors(id) on delete cascade,
  blocked_id bigint not null references authors(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint blocks_not_self check (blocker_id <> blocked_id)
);

-- 목록 조회마다 "이 글의 작성자를 내가 차단했나" 를 묻는다 — PK 선두가 blocker_id 라 그 질문은
--  PK 로 끝난다. 반대 방향(내가 차단당했나)은 쓰기 차단에서 쓰므로 인덱스를 따로 둔다.
create index if not exists blocks_blocked_idx on blocks (blocked_id);
