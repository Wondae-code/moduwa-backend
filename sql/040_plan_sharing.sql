-- 플랜 공동 편집 — 멤버 · 초대 코드 · 버전(낙관적 잠금).
--
-- ── 구조
--   plans.author_id  = 소유자 (그대로 둔다 — 기존 소유권 검사 5곳의 최소 변경)
--   plan_members     = 초대받은 편집자. 소유자는 여기 넣지 않는다 — 두 곳에 있으면
--                      "소유자인데 멤버이기도 한" 행이 생겨 권한 계산이 두 갈래가 된다.
--   plan_invites     = 초대 코드. 이메일 인증(031)과 같은 규칙 — **해시만 저장**, 만료, 회수.
--
-- ── 왜 version 인가 (이 파일의 핵심)
--   PUT /v1/plans 는 본문을 **통째로 교체**한다. 한 사람일 때는 옳은 설계였지만 편집자가
--   여럿이면 늦게 저장한 사람이 이기고 먼저 저장한 사람의 작업이 **소리 없이 사라진다.**
--   (A 가 1일차를 고치는 동안 B 가 2일차를 고치면, B 의 저장이 A 의 1일차를 되돌린다)
--   그래서 저장마다 version 을 올리고, 클라이언트가 들고 온 version 과 다르면 409 로 거절한다.
--   실시간 공동 편집(OT/CRDT)은 규모가 다른 프로젝트다 — 이것은 유실을 막고 충돌을
--   사용자에게 정직하게 보여주는 최소 장치다.
--
--  migrate 는 내용 해시로 재적용을 판단하므로 이 파일은 전부 멱등이어야 한다.

alter table plans add column if not exists version integer not null default 1;

create table if not exists plan_members (
  plan_id   uuid   not null references plans(id)   on delete cascade,
  author_id bigint not null references authors(id) on delete cascade,
  -- v1 은 editor 하나다. viewer 가 필요해지면 값을 늘린다 — 등급마다 앱 UI 와 권한 검사가
  -- 함께 늘어나므로 미리 만들지 않는다.
  role      text   not null default 'editor' check (role in ('editor')),
  joined_at timestamptz not null default now(),
  primary key (plan_id, author_id)
);
-- "내가 초대받은 플랜" 목록 조회용 (plan_id 쪽은 PK 선두라 인덱스가 이미 있다)
create index if not exists idx_plan_members_author on plan_members (author_id);

create table if not exists plan_invites (
  id         bigserial primary key,
  plan_id    uuid   not null references plans(id)   on delete cascade,
  -- ⚠️ 코드 원문은 저장하지 않는다. sha256 16진 문자열이다(031 과 같은 이유 — 코드 공간이
  --    작아서가 아니라, DB 가 새면 살아 있는 초대가 전부 열리기 때문).
  code_hash  text   not null unique,
  created_by bigint not null references authors(id) on delete cascade,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_plan_invites_plan on plan_invites (plan_id) where revoked_at is null;

-- 만료 코드 청소. 만료는 조회 조건이 이미 거르므로 남아 있어도 위험하지 않다(031 과 동일).
delete from plan_invites where expires_at < now() - interval '7 days';
