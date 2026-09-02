-- 신고 처리 기록 — 운영 화면(대시보드 "신고" 탭)이 쓴다.
--
--  ⚠️ 심사에서 "신고에 어떻게 대응하나" 를 물었을 때, 신고를 **볼 수 있다**는 것만으로는
--     답이 되지 않는다. 누가 언제 무엇을 판단했는지가 남아야 "절차" 다.
--
--  ⚠️ 콘텐츠를 지우는 컬럼이 아니다. 신고는 대상을 감추지 않는다는 원칙(043·047)은 그대로다 —
--     여기 남는 것은 **판단의 기록**이고, 실제 조치가 필요하면 사람이 따로 한다.
--
--  migrate 는 내용 해시로 재적용을 판단하므로 이 파일은 멱등이어야 한다.
alter table reports add column if not exists resolved_at   timestamptz;
alter table reports add column if not exists resolved_note text;

comment on column reports.resolved_at is
  '운영이 판단을 마친 시각. null 이면 아직 볼 것으로 남아 있다.';
comment on column reports.resolved_note is
  '판단 내용(예: 조치함 / 문제 없음). 화면에 그대로 보인다.';

-- 미처리 신고를 최근순으로 훑는 경로 — 운영 화면의 기본 목록이다.
create index if not exists idx_reports_open on reports (created_at desc) where resolved_at is null;
