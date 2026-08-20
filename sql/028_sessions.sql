-- 로그인 세션 — "이 요청이 누구인가"를 device_id 대신 이 토큰이 답한다.
--
--  024 가 예고한 규칙("로그인한 사용자의 요청은 device_id 를 신뢰하지 않는다")을 실제로
--  가능하게 만드는 파일이다. 이게 없으면 계정에 기기를 여러 대 묶는 순간, 기기 한 대의
--  device_id 유출이 그 기기가 아니라 **계정 전체**를 여는 문제가 된다.
--
--  ── 왜 불투명(opaque) 토큰 + DB 조회인가. 왜 JWT 가 아닌가 ──────────────────────
--   ① 즉시 폐기가 필요하다. 로그아웃·기기 분실은 "지금 끊기"인데 JWT 는 만료까지 산다.
--      리프레시 토큰을 따로 두면 결국 여기와 같은 테이블을 만들게 된다.
--   ② 조회 비용이 사실상 없다. 이 API 는 어차피 요청마다 DB 를 친다(플랜·게시글·후기).
--   ③ 새 의존성이 0 이다 — node:crypto 의 randomBytes/createHash 만으로 끝난다.
--      (dashboard-auth.ts 가 같은 이유로 서명 쿠키를 직접 구현해 두었다)
--
--  migrate 는 전체를 매번 재실행하므로 이 파일은 전부 멱등이어야 한다.

create table if not exists author_sessions (
  id           uuid primary key default gen_random_uuid(),
  author_id    bigint not null references authors(id) on delete cascade,

  -- ⚠️ 토큰 **원문은 저장하지 않는다.** sha256 16진 문자열만 둔다.
  --    DB 가 통째로 새도 그것만으로는 남의 세션이 될 수 없어야 한다.
  --    (비밀번호와 달리 토큰은 128비트 난수라 느린 해시가 필요 없다 — 사전 공격 대상이 아니다)
  token_hash   text   not null unique,

  -- 어느 기기의 세션인가. author_devices 와 역할이 다르다 —
  --  author_devices 는 "이 기기는 지금 누구 것인가"(정본), 여기는 "이 세션이 어디서 났나"(기록).
  --  기기 목록 화면·이상 로그인 알림에 쓸 수 있게 남긴다. 로그인 없이 발급될 일은 없지만
  --  기기를 못 알아낸 요청도 허용해야 하므로 null 을 허용한다.
  device_id    text,

  created_at   timestamptz not null default now(),
  last_used_at timestamptz not null default now(),

  -- 슬라이딩 만료. 검증에 성공할 때마다 뒤로 민다(sessions.ts).
  --  고정 만료로 두면 매일 쓰는 사용자도 90일마다 이유 없이 튕긴다.
  expires_at   timestamptz not null,

  -- 로그아웃·강제 폐기. 행을 지우지 않고 시각을 남기는 이유는 "언제 왜 끊겼나"를 볼 수 있어서다.
  --  (지워 버리면 로그아웃과 "그런 세션은 없었다"를 구분할 수 없다)
  revoked_at   timestamptz
);

-- "이 계정의 살아 있는 세션" — 다른 기기 로그아웃·기기 목록에서 쓴다.
--  부분 인덱스라 폐기된 행이 쌓여도 인덱스는 커지지 않는다.
create index if not exists idx_author_sessions_author on author_sessions (author_id)
  where revoked_at is null;

-- 한 기기의 세션을 찾는다(로그아웃 시 그 기기 것만 끊기).
create index if not exists idx_author_sessions_device on author_sessions (device_id)
  where device_id is not null;

-- 오래 지난 것 청소. 별도 잡을 두지 않고 migrate 때 한 번 쓸면 충분하다 —
--  세션은 만료되면 검증에서 이미 거부되므로 남아 있어도 위험하지 않고, 양도 많지 않다.
--  30일을 두는 것은 "지난주에 왜 로그아웃됐지" 같은 문의를 추적할 여지를 남기기 위함이다.
delete from author_sessions where expires_at < now() - interval '30 days';
