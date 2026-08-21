-- 사용자 무장애 프로필 — 온보딩에서 받는 "나에게 필요한 접근성" 정보.
--
--  ⚠️ 이 파일과 함께 정책이 바뀐다: **쓰기는 로그인해야 한다.**
--     그래서 authors 행은 이제 **로그인 계정에만** 생긴다. 익명 기기가 authors 를 만드는
--     경로(017 이후의 `insert into authors (device_id, …)`)는 전부 없어졌다.
--     온보딩 답변은 앱 로컬에 있다가 가입할 때 함께 올라와 여기에 저장된다.
--
--     이 결정이 024 가 남겨 둔 마지막 위험을 없앤다 — deviceId 만 알면 그 기기의 익명 계정을
--     가입으로 가져갈 수 있던 문제다. 가져갈 익명 계정이 애초에 생기지 않으므로, 병합 경로
--     자체를 제거했다(accounts.ts).
--
--  migrate 는 전체를 매번 재실행하므로 이 파일은 전부 멱등이어야 한다.

-- 어떤 접근성이 필요한 사람인가. 목록·검색을 개인화하고, 게시글 작성 시 기본값으로도 쓴다.
--
--  ⚠️ posts.access_features(027)와 **같은 코드 어휘**를 쓴다 — 앱의 AccessibilityFeature
--     rawValue 그대로(wheelchairAccessible, hearingFriendly, visuallyImpairedFriendly,
--     elderlyFriendly, childFriendly …). 두 곳이 어휘를 공유해야 "내 프로필로 게시글 필터"가
--     성립한다.
--  DB 에서 값을 검증하지 않는 것도 027 과 같은 판단이다 — 앱이 항목을 늘리면 서버 배포 없이
--     따라가야 하고, 모르는 코드는 앱이 무시하면 그만이다.
alter table authors add column if not exists access_features text[] not null default '{}';

-- 온보딩을 마친 시각. "프로필이 비어 있다"와 "온보딩에서 아무것도 고르지 않았다"를 구분한다.
--  전자는 온보딩을 다시 띄워야 하고 후자는 띄우면 안 된다 — 빈 배열만으로는 알 수 없다.
alter table authors add column if not exists onboarded_at timestamptz;

-- "휠체어가 필요한 사용자" 같은 코호트 조회(운영 통계·개인화)를 위한 GIN.
--  027 의 posts_access_idx 와 같은 모양이다.
create index if not exists authors_access_idx on authors using gin (access_features);
