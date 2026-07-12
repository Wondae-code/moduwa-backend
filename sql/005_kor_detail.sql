-- KorService2 본 POI 상세 enrich (detailCommon2 + detailIntro2) — content_id당 1행.
-- detailCommon2: 개요(overview)·홈페이지·전화 → 타입드 컬럼 + 원본.
-- detailIntro2 : 운영시간·이용요금 등 → 타입(contentTypeId)마다 필드가 달라 raw JSONB로 보존.
-- 진행상황은 이 테이블 존재 여부로 추적(있으면 완료) → 재실행 시 누락분만, 관광지 유형 우선.
create table if not exists kor_detail (
  content_id      text primary key,
  content_type_id text,
  overview        text,            -- detailCommon2 개요
  homepage        text,            -- detailCommon2 홈페이지
  tel             text,            -- detailCommon2 전화
  common_raw      jsonb,           -- detailCommon2 원본
  intro_raw       jsonb,           -- detailIntro2 원본(운영시간·요금 등, 타입별 상이)
  has_common      boolean not null default false,
  has_intro       boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_kd_type on kor_detail (content_type_id);
create index if not exists idx_kd_hascommon on kor_detail (has_common);
