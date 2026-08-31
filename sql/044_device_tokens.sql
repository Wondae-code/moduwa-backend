-- 푸시 알림 기기 토큰 — APNs 발송 대상.
--
--  앱 팀 요청(2026-08-31) 5-1. 발송 코드는 APNs 인증 키(.p8)가 도착한 뒤에 붙지만,
--  토큰 등록은 그와 독립이라 먼저 열어 둔다 — 앱이 권한 요청·등록을 먼저 붙일 수 있다.
--
--  ⚠️ **environment 를 토큰과 함께 보관한다.** TestFlight·앱스토어 빌드는 production,
--     Xcode 로 꽂은 빌드는 sandbox 이고, 반대쪽 게이트웨이로 보내면 BadDeviceToken 으로
--     **조용히** 실패한다. 토큰만 저장하면 그 실패를 진단할 방법이 없다.
--
--  ⚠️ 토큰이 PK 다. 기기·설치 단위로 유일하고, 같은 사람이 여러 기기를 쓰거나 한 기기를
--     여러 사람이 쓸 수 있다(재설치·계정 전환) — 후자에서 author_id 가 바뀌어야 하므로
--     재등록은 upsert 로 소유자까지 갱신한다. 안 그러면 로그아웃한 사람에게 알림이 계속 간다.
--
--  ⚠️ APNs 가 410 Unregistered 를 주면 그 행을 지운다(발송 코드에서). 죽은 토큰을 쌓아 두면
--     발송량이 계속 늘고 실패율 지표가 흐려진다.
--
--  migrate 는 내용 해시로 재적용을 판단하므로 이 파일은 멱등이어야 한다.

create table if not exists device_tokens (
  token       text primary key,
  author_id   bigint not null references authors(id) on delete cascade,
  platform    text   not null default 'ios',
  -- 'sandbox' | 'production'. 발송 게이트웨이를 가르는 값이라 not null 이다.
  environment text   not null,
  bundle_id   text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- "이 사람의 기기들" — 발송의 주 조회 경로.
create index if not exists idx_device_tokens_author on device_tokens (author_id);
