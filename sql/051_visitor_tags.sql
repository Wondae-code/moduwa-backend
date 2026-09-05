-- 방문 조건 태그 — "어떤 조건으로 방문했는지" 를 후기에 남긴다.
--
--  같은 조건인 사람의 후기가 훨씬 믿을 만하다는 것이 이 앱의 전제다. 그 정보를 보여 주되,
--  **프로필이 아니라 후기에** 붙인다.
--
-- ⚠️ **왜 프로필 속성(authors.access_features)을 공개하지 않는가**
--    ① 자기 신고라 관문이 되지 못한다 — "휠체어 이용자끼리만" 은 체크박스 하나면 통과다.
--    ② 프로필에 붙은 값은 그 사람의 **모든 글에 영구히** 따라다닌다. authorInfo.uuid 가 이미
--       응답에 있어(048 차단 기능), 장애 정보와 이동 기록이 한 사람 앞으로 묶인다.
--    ③ /privacy 2항과 동의 문구에 "다른 이용자에게 공개되지 않습니다" 라고 적었다. 뒤집으려면
--       목적 변경 + 제3자 공개 동의를 다시 받아야 한다.
--    후기 태그는 **본인이 그 글에 직접 밝힌 내용**이라 이 셋 모두 해당하지 않는다. 글 하나에만
--    붙고, 그 후기를 지우면 함께 사라진다.
--
-- ⚠️ **기존 태그와 kind 로 가른다.** 기존 8개는 장소 평가("음식이 맛있어요")이고 새 태그는
--    방문자 조건("휠체어로 방문했어요")이다. 한 목록에 섞으면 장소 요약 막대가
--    "21명이 무장애 친화적이라고 했다" 와 "21명이 휠체어로 방문했다" 를 같은 줄에 세우게 되어
--    막대의 뜻이 깨진다. 요약은 kind='place' 만 집계한다.
--
--  migrate 는 내용 해시로 재적용을 판단하므로 이 파일은 멱등이어야 한다.

alter table review_tag_defs add column if not exists kind text not null default 'place';

comment on column review_tag_defs.kind is
  'place = 장소 평가(요약 막대에 집계) · visitor = 방문 조건(후기 뱃지·필터에만 쓴다)';

-- 기존 8개는 전부 장소 평가다(default 로 이미 place 지만 명시해 둔다).
update review_tag_defs set kind = 'place' where kind is distinct from 'place' and code in
  ('barrier_free', 'silver', 'kids', 'pet', 'taste', 'value', 'kind', 'parking');

-- ── 방문 조건 태그 ──────────────────────────────────────────────────────────
--  프로필의 access_features 다섯 축과 같은 순서·같은 뜻으로 맞춘다. 앱이 프로필 값을 보고
--  작성 화면에서 **미리 체크해 제안**할 수 있게 하기 위함이다(저장은 후기 쪽에만 한다).
--  sort_order 를 100 부터 두어 기존 태그와 섞이지 않게 한다.
--  do update 라 문구를 고치고 migrate 만 다시 돌리면 반영된다(019 와 같은 방식).
insert into review_tag_defs (code, label, short_label, icon, sort_order, kind) values
  ('visit_wheelchair', '휠체어로 방문했어요',   '휠체어 방문', 'access_wheelchair', 101, 'visitor'),
  ('visit_visual',     '시각장애가 있어요',     '시각',       'access_visual',     102, 'visitor'),
  ('visit_hearing',    '청각장애가 있어요',     '청각',       'access_hearing',    103, 'visitor'),
  ('visit_infant',     '유아를 동반했어요',     '유아 동반',   'access_infant',     104, 'visitor'),
  ('visit_elderly',    '어르신과 함께 갔어요',  '어르신 동행', 'access_elderly',    105, 'visitor')
on conflict (code) do update set
  label = excluded.label, short_label = excluded.short_label,
  icon = excluded.icon, sort_order = excluded.sort_order, kind = excluded.kind;

-- 방문 조건으로 후기를 거르는 경로(GET /v1/reviews?visitorTag=...). 기존 PK 는 review_id 선두라
--  태그에서 후기로 되짚는 방향이 없었다 — 019 주석이 예고한 그 인덱스다.
create index if not exists idx_review_tags_code on review_tags (tag_code, review_id);
