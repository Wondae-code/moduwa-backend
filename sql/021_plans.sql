-- 여행 플랜 저장 — iOS 플랜 탭(목록·상세·편집)의 영속화.
--  지금까지 플랜은 앱 안의 목 데이터였다. 편집 화면이 생기면서 순서를 바꿔도 화면을 벗어나면
--  사라지는 상태가 됐고, 그걸 없애기 위한 스키마다.
--
--  소유자는 리뷰와 같은 방식이다: 로그인 없이 기기 UUID + 닉네임 → authors 대리키(017).
--  플랜은 리뷰와 달리 **남에게 보이지 않는 개인 데이터**라 조회도 소유자로 좁힌다.

create table if not exists plans (
  id          uuid primary key,
  author_id   bigint not null references authors(id) on delete cascade,
  title       text   not null,
  start_date  date   not null,
  end_date    date   not null,
  -- iOS TravelRegion 의 rawValue(gyeongju 등). enum 으로 굳히지 않는 이유는 지역 목록이
  -- 기획에서 계속 바뀌는 값이라, 앱만 고쳐도 되게 두는 편이 낫기 때문이다.
  region      text,
  -- TravelParty(연령대·동반자·이동수단 집합). 앱에서만 해석하는 값이라 통째로 jsonb 로 둔다 —
  -- 컬럼으로 펼치면 항목이 늘 때마다 마이그레이션이 필요하고 서버가 쓸 일은 없다.
  party       jsonb  not null default '{}'::jsonb,
  cover_image_url text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 목록은 항상 "내 플랜을 최근 여행부터"라서 이 순서로 인덱스를 둔다.
create index if not exists idx_plans_author on plans (author_id, start_date desc);

create table if not exists plan_days (
  id       uuid primary key,
  plan_id  uuid not null references plans(id) on delete cascade,
  -- 시작일+인덱스로 계산하지 않고 명시한다. 기간 중 하루를 비우거나 나중에 끼워 넣는
  -- 편집을 막지 않기 위해서다(iOS PlanDay 주석과 같은 이유).
  date     date not null,
  position smallint not null
);
create index if not exists idx_plan_days_plan on plan_days (plan_id, position);

-- 장소와 메모가 한 타임라인에 섞인다. 둘을 따로 두면 순서를 합쳐 다시 세워야 하므로
--  한 테이블에 kind 로 구분해 담고 position 하나로 순서를 정한다.
create table if not exists plan_items (
  id        uuid primary key,
  day_id    uuid not null references plan_days(id) on delete cascade,
  position  smallint not null,
  kind      text not null check (kind in ('stop', 'memo')),

  -- kind='memo'
  memo_text text,

  -- kind='stop' — 관광공사 원본을 다시 조회하지 않고 박제한다.
  --  지난 여행은 원본 POI 가 사라져도 그대로 보여야 하고, 오프라인에서도 그려져야 한다.
  content_id     text,
  place_name     text,
  category_label text,
  category       text,
  region         text,
  image_url      text,
  latitude       double precision,
  longitude      double precision,

  -- 종류별로 필요한 값이 채워졌는지 DB 에서 막는다. 앱이 잘못 보내도 반쪽 데이터가 남지 않는다.
  constraint plan_items_kind_fields check (
    (kind = 'memo' and memo_text is not null)
    or (kind = 'stop' and place_name is not null and category_label is not null)
  )
);
create index if not exists idx_plan_items_day on plan_items (day_id, position);

-- 이동 거리는 저장하지 않는다. 좌표만 있으면 계산할 수 있고, 저장해 두면 장소 순서를
-- 바꿀 때마다 갱신해야 하는데 그 갱신을 어딘가에서 반드시 빠뜨린다(iOS 도 같은 이유로
-- 저장 필드를 없앴다).
