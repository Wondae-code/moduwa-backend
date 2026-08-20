-- 이메일 로그인 + 네이버 provider — 024 의 신원 테이블을 실제로 쓸 수 있게 채운다.
--
--  024 는 provider 목록에 'email' 을 넣어 두었지만 비밀번호를 둘 자리가 없어서 실제로는
--  이메일 가입을 할 수 없었다. 그 칸을 여기서 만든다.
--
--  migrate 는 전체를 매번 재실행하므로 이 파일은 전부 멱등이어야 한다.

-- ── 비밀번호 ─────────────────────────────────────────────────────────────────
--  author_identities 에 두는 이유: 이메일 계정에서 "그 이메일 + 그 비밀번호"가 하나의
--  신원(identity)이다. authors 에 두면 소셜만 쓰는 계정에도 영원히 null 인 칸이 생기고,
--  한 계정에 이메일 신원을 붙였다 떼는 일(연결 해제)이 authors 를 건드리게 된다.
--
--  ⚠️ 평문·단순 해시를 절대 넣지 않는다. 값의 형식은 password.ts 가 정하며
--     알고리즘 파라미터를 값 안에 함께 담는다(scrypt$N$r$p$salt$hash) —
--     나중에 강도를 올려도 기존 비밀번호가 그대로 검증되게 하기 위함이다.
--  provider <> 'email' 인 행에서는 항상 null 이다(소셜은 비밀번호가 없다).
alter table author_identities add column if not exists password_hash text;

-- ── 네이버 ───────────────────────────────────────────────────────────────────
--  024 의 check 에 'naver' 가 빠져 있었다. 지금 넣어 두면 네이버 로그인을 붙일 때
--  마이그레이션을 또 만들지 않아도 된다(데이터에 영향이 없는 제약 완화라 지금 해도 안전하다).
--
--  drop → add 순서라 재실행해도 안전하다. add constraint 자체는 멱등이 아니므로
--  drop if exists 를 반드시 앞에 둬야 한다.
alter table author_identities drop constraint if exists author_identities_provider_check;
alter table author_identities add constraint author_identities_provider_check
  check (provider in ('apple', 'google', 'kakao', 'naver', 'email'));

-- 이메일 신원의 subject 는 **소문자화한 이메일**이다(별도 컬럼을 두지 않는 이유:
--  (provider, subject) 유니크가 이미 "한 이메일에 계정 하나"를 보장한다).
--  Foo@x.com 과 foo@x.com 이 다른 계정이 되지 않도록 쓰기 전에 반드시 소문자화할 것 —
--  DB 는 이것을 강제하지 않으므로 accounts.ts 가 지킨다.
comment on column author_identities.subject is
  'OIDC sub. provider=email 인 경우에는 소문자화한 이메일 주소.';
