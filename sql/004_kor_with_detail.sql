-- 무장애 여행 상세 (KorWithService2/detailWithTour2) — content_id당 1행
-- 28개 배리어프리 속성(자유 텍스트) + has_detail(속성 1개라도 있으면 true).
-- 진행상황은 이 테이블 존재 여부로 추적(있으면 수집완료) → 재실행 시 누락분만.
create table if not exists kor_with_detail (
  content_id text primary key,
  -- ① 지체장애·공통
  parking text, route text, publictransport text, ticketoffice text, promotion text,
  wheelchair text, exit text, elevator text, restroom text, auditorium text, room text, handicapetc text,
  -- ② 시각장애
  braileblock text, helpdog text, guidehuman text, audioguide text, bigprint text,
  brailepromotion text, guidesystem text, blindhandicapetc text,
  -- ③ 청각장애
  signguide text, videoguide text, hearingroom text, hearinghandicapetc text,
  -- ④ 영유아·가족
  stroller text, lactationroom text, babysparechair text, infantsfamilyetc text,
  -- 메타
  has_detail boolean not null default false,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_kwd_hasdetail on kor_with_detail (has_detail);
