-- 무장애: 실제 접근성 속성(28개 중 1개 이상) 보유 여부 플래그.
--  홈 피드 수용기준("이미지+이동편의 정보 1개 이상 보유")을 위한 필터용.
alter table barrier_free add column if not exists has_access boolean not null default false;
create index if not exists idx_bf_hasaccess on barrier_free (has_access);
