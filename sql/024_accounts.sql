-- 계정(회원가입) 기반 — 익명 기기 신원을 계정으로 승격하고, 한 계정에 기기 여러 대를 묶는다.
--
--  017 이 예고한 확장을 실제로 놓는다. reviews/plans/review_comments 는 처음부터 device_id 가
--  아니라 불변 대리키 authors.id 만 참조하도록 만들어 뒀으므로, 계정을 붙여도 그 관계는
--  한 줄도 건드리지 않는다. 이 파일이 하는 일은 authors 위에 "계정"과 "기기"를 얹는 것뿐이다.
--
--  ⚠️ 이 마이그레이션으로 device_id 의 성격이 바뀐다 — 이게 이 변경의 핵심이다.
--     지금까지 device_id 는 사실상 인증 수단(bearer)이었다. 아는 사람이 곧 그 사람이고,
--     GET /v1/plans?deviceId= 는 그것만으로 남의 플랜을 내준다.
--     계정 하나에 기기를 여러 대 묶는 순간 그 성질이 위험해진다. 기기 한 대의 device_id 가
--     새면 그 기기의 데이터가 아니라 **계정 전체**(다른 기기에서 쓴 것까지)가 열리기 때문이다.
--     → 로그인한 사용자의 요청은 device_id 를 신뢰하지 않고 세션 토큰에서 author 를 꺼내야 한다.
--       device_id 는 "어느 기기인가"를 아는 식별자로만 남는다.
--     이 파일은 데이터 모델만 놓는다. 위 규칙의 강제는 세션 도입과 함께 API 쪽에서 한다.
--
--  migrate 는 전체를 매번 재실행하므로 이 파일은 전부 멱등이어야 한다.

-- ── 계정 ──────────────────────────────────────────────────────────────────────

-- 외부 노출용 식별자. authors.id(bigserial) 를 UUID 로 바꾸지 않는 이유는 FK 가 세 군데
--  (reviews·plans·review_comments) 걸려 있어 교체 비용만 크고 얻는 게 없기 때문이다.
--  대신 API 에 내보낼 값을 따로 둔다 — bigserial 을 그대로 노출하면 가입자 수가 새고
--  다음 번호를 찍어 순회할 수 있다.
--  (volatile 기본값이라 ADD COLUMN 시 기존 행마다 서로 다른 값이 채워진다)
alter table authors add column if not exists uuid uuid default gen_random_uuid();
update authors set uuid = gen_random_uuid() where uuid is null;
alter table authors alter column uuid set not null;
create unique index if not exists idx_authors_uuid on authors (uuid);

-- 계정 이메일. 소셜에서 받은 것이든 이메일 가입이든 "이 계정의 대표 주소" 한 칸이다.
--  대소문자를 구분하지 않는 부분 유니크 인덱스로 둔다 — text unique 로는 Foo@x.com 과
--  foo@x.com 이 다른 계정이 되어 버린다. 익명 계정은 null 이므로 부분 인덱스가 필요하다.
alter table authors add column if not exists email text;
alter table authors add column if not exists email_verified_at timestamptz;
create unique index if not exists idx_authors_email
  on authors (lower(email)) where email is not null;

-- ── 소셜·이메일 신원 ──────────────────────────────────────────────────────────
--  provider 를 authors 컬럼으로 두지 않는 이유: 한 사람이 애플로 가입한 뒤 카카오도
--  같은 계정에 붙이는 게 자연스럽고, 컬럼이면 그게 불가능하다.
--  subject 는 프로바이더가 주는 고유 사용자 ID(OIDC sub)다. 이메일은 바뀔 수 있으므로
--  이메일이 아니라 subject 가 계정을 찾는 키다.
create table if not exists author_identities (
  id         bigserial primary key,
  author_id  bigint not null references authors(id) on delete cascade,
  provider   text   not null check (provider in ('apple', 'google', 'kakao', 'email')),
  subject    text   not null,
  -- 발급 당시 프로바이더가 알려준 주소. authors.email 과 달리 갱신하지 않는 기록값이다.
  --  (애플은 최초 인가 때만 이메일을 준다 — 그때 받은 값을 여기 남겨 둔다)
  email      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, subject)
);
create index if not exists idx_author_identities_author on author_identities (author_id);

-- ── 기기 ──────────────────────────────────────────────────────────────────────
--  device_id 가 PK 다 = 한 기기는 한 순간에 한 계정에만 묶인다.
--  로그아웃은 이 행을 지우는 것이고, 그 기기의 다음 익명 활동은 새 빈 authors 행을 만든다
--  ("로그아웃하면 빈 계정으로"). 익명으로 되돌리지 않는 이유는 두 가지다.
--    · 로그아웃한 사람 화면에 계정 데이터가 남아 보일 여지를 없앤다.
--    · 로그인 때 익명 데이터를 계정으로 병합했으므로 되돌릴 익명 데이터가 애초에 없다.
--      사용자가 잃는 것도 없다 — 다시 로그인하면 그대로 돌아온다.
create table if not exists author_devices (
  device_id     text   primary key,
  author_id     bigint not null references authors(id) on delete cascade,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);
create index if not exists idx_author_devices_author on author_devices (author_id);

-- 기존 authors.device_id 를 이관한다. 멱등이라 재실행해도 덮어쓰지 않는다.
insert into author_devices (device_id, author_id)
  select device_id, id from authors where device_id is not null
  on conflict (device_id) do nothing;

-- authors.device_id 는 **지우지 않는다.**
--  · 구버전 앱이 한동안 그 경로로 계속 들어온다.
--  · migrate 는 prod 에도 그대로 도는데 authors 는 push-data.sh 동기화 제외 대상이라
--    (017 상단 경고) 잘못 지우면 로컬에서 되돌릴 방법이 없다.
--  정본은 author_devices 이고 authors.device_id 는 이중 기록(dual-write)으로만 유지한다.
--  양쪽이 갖춰지고 구버전 앱이 빠진 뒤에 별도 마이그레이션으로 드롭한다.
