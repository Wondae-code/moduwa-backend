-- 이메일 인증·비밀번호 재설정 코드.
--
--  이 파일이 029 가 남긴 구멍을 메운다 — 이메일 로그인은 됐지만 **비밀번호를 잊으면 계정을
--  되찾을 방법이 없었다.** 그게 이메일 로그인을 열어 둔 채 출시할 수 없는 이유였다.
--
--  ── 왜 링크가 아니라 6자리 코드인가 ─────────────────────────────────────────
--   moduwa.app 에 아직 웹 페이지가 없다. 링크를 보내면 눌러도 도착할 곳이 없다.
--   코드는 앱에서 입력받으면 되므로 웹 없이 지금 동작한다.
--   대가는 추측 가능성이다(10^6). 그래서 아래 세 가지로 막는다 —
--     ① 단회용(used_at)  ② 짧은 만료  ③ **코드별 시도 횟수 상한**(attempts)
--   ③ 이 핵심이다. 이것 없이 6자리는 그냥 뚫린다.
--   웹 페이지가 생기면 긴 토큰 링크를 병행하면 된다(이 테이블 그대로 쓸 수 있다).
--
--  migrate 는 전체를 매번 재실행하므로 이 파일은 전부 멱등이어야 한다.

create table if not exists author_email_codes (
  id         bigserial primary key,
  author_id  bigint not null references authors(id) on delete cascade,
  purpose    text   not null check (purpose in ('verify', 'reset')),

  -- 발송한 주소. authors.email 을 그때그때 보지 않고 여기 박아 두는 이유:
  --  코드를 받은 주소와 지금 계정 주소가 다를 수 있다(그 사이 주소를 바꿨다).
  --  "그 주소로 보낸 코드"가 "지금 주소"를 인증해 버리면 안 된다.
  email      text   not null,

  -- ⚠️ 코드 원문은 저장하지 않는다. sha256(author_id:purpose:code) 16진 문자열이다.
  --    author_id 를 섞는 이유는 같은 코드가 사용자마다 다른 해시가 되게 하려는 것이다
  --    (10^6 공간이라 순수 sha256(code) 는 무지개표 하나로 전부 역산된다).
  code_hash  text   not null,

  -- 이 코드에 대한 시도 횟수. 상한을 넘으면 코드를 폐기한다.
  --  계정을 잠그지 않는다 — 그러면 남의 계정을 잠글 수 있다. 코드만 죽이고 재발송을 유도한다.
  attempts   int    not null default 0,

  expires_at timestamptz not null,
  -- 단회용. 성공하면 시각을 찍고, 그 뒤 같은 코드는 통하지 않는다.
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

-- "이 계정의 살아 있는 코드" — 검증과 재발송이 모두 이 조회를 쓴다.
create index if not exists idx_email_codes_lookup
  on author_email_codes (author_id, purpose, created_at desc)
  where used_at is null;

-- 오래 지난 것 청소. 만료된 코드는 검증에서 이미 거부되므로 남아 있어도 위험하지 않다.
--  세션(028)과 같은 방식으로 migrate 때 한 번 쓸면 충분하다.
delete from author_email_codes where expires_at < now() - interval '7 days';
