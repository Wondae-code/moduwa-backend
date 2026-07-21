-- 무장애: 접근성 배지용 4그룹(이동·시각·청각·영유아) 보유 플래그 + 검색 인덱스.
--  /v1/search(#3) 결과 행의 뱃지 렌더링용. has_access(013)와 같은 패턴 — ingest:barrier-free 가 계산·갱신.
alter table barrier_free add column if not exists access_wheelchair boolean not null default false;
alter table barrier_free add column if not exists access_visual     boolean not null default false;
alter table barrier_free add column if not exists access_hearing    boolean not null default false;
alter table barrier_free add column if not exists access_infant     boolean not null default false;

-- title 부분 일치 + addr1 지역 매칭(ILIKE '%q%')용 trigram 인덱스
create extension if not exists pg_trgm;
create index if not exists idx_bf_title_trgm on barrier_free using gin (title gin_trgm_ops);
create index if not exists idx_bf_addr1_trgm on barrier_free using gin (addr1 gin_trgm_ops);
