-- 방문 후기 태그 + 재방문 의향 — 기획 스케치(2026-08-08) 반영.
--  후기 작성 시 "어떤 점이 좋았나요?"에서 다중 선택하고, 같은 값이 세 곳에 쓰인다.
--   ① 작성 화면 칩            → label      ("무장애 친화적이에요")
--   ② 장소 집계 막대           → label + 인원수
--   ③ 개별 후기 뱃지           → short_label ("무장애")
--  긴 이름과 짧은 이름이 화면마다 다르므로 카탈로그에 둘 다 둔다.
--
--  ⚠️ 이 태그는 kor_with_detail 의 무장애 28속성과 성격이 다르다. 저쪽은 관광공사가 준
--     "사실"이고 이쪽은 방문자가 느낀 "주관"이다. 화면에서 섞어 보여주지 말 것.

-- ── 카탈로그 ─────────────────────────────────────────────────────────────────
--  테이블로 두는 이유: 스케치의 태그 목록이 아직 확정이 아니다(긴 이름 8개와 짧은 이름
--  8개가 서로 어긋나 있었다). DB 에 두면 문구·순서·아이콘 변경에 앱 재배포가 필요 없다.
create table if not exists review_tag_defs (
  code        text primary key,
  label       text not null,              -- 작성 칩·집계 막대 문구
  short_label text not null,              -- 개별 후기 뱃지 문구
  icon        text,                       -- 앱 에셋 이름. null 이면 텍스트만 렌더한다
  sort_order  smallint not null default 0
);

-- 스케치 원문 8개 중 실버·맛은 긴 이름이 없었고 아이 관련이 둘로 겹쳐 있어 정리했다.
--  icon 이 null 인 4개(반려동물·가성비·친절·주차)는 브랜드 가이드에 해당 아이콘이 없다.
--  에셋이 생기면 여기만 채우면 된다.
--  do update 로 두어 문구를 고치고 npm run migrate 만 다시 돌리면 반영된다.
insert into review_tag_defs (code, label, short_label, icon, sort_order) values
  ('barrier_free', '무장애 친화적이에요',        '무장애',   'access_wheelchair', 1),
  ('silver',       '어르신과 함께하기 좋아요',   '실버',     'access_elderly',    2),
  ('kids',         '아이와 함께하기 좋아요',     '키즈',     'access_child',      3),
  ('pet',          '반려동물과 함께하기 좋아요', '반려동물', null,                4),
  ('taste',        '음식이 맛있어요',            '맛',       'category_food',     5),
  ('value',        '가성비가 좋아요',            '가성비',   null,                6),
  ('kind',         '직원이 친절해요',            '친절',     null,                7),
  ('parking',      '주차가 편해요',              '주차',     null,                8)
on conflict (code) do update set
  label       = excluded.label,
  short_label = excluded.short_label,
  icon        = excluded.icon,
  sort_order  = excluded.sort_order;

-- ── 후기 ↔ 태그 ──────────────────────────────────────────────────────────────
--  후기가 지워지면 태그도 함께 지운다(cascade). 삭제 라우트는 아직 없지만 DB 를 직접
--  손볼 때 고아 행이 남지 않게 한다.
create table if not exists review_tags (
  review_id bigint not null references reviews(id) on delete cascade,
  tag_code  text   not null references review_tag_defs(code) on delete cascade,
  primary key (review_id, tag_code)
);
-- 장소별 집계는 reviews(content_id) 로 후기를 좁힌 뒤 위 PK 로 태그를 찾으므로
-- 별도 인덱스가 필요 없다. tag_code 기준 역방향 조회가 생기면 그때 추가한다.

-- ── 재방문 의향 ──────────────────────────────────────────────────────────────
--  스케치의 체크박스. **오직 유저가 직접 고른 값만 들어간다.**
--   ⚠️ 별점에서 파생하지 말 것. 별점이 높아도 멀거나 비싸서 다시 안 갈 수 있고, 낮아도
--      가까워서 또 갈 수 있다. 두 축은 독립이며 그래서 따로 묻는 값이다.
--   세 상태를 구분한다: true=재방문 의향 있음 / false=없음 / null=응답 없음.
alter table reviews add column if not exists would_revisit boolean;

-- ── 시연 시드 ────────────────────────────────────────────────────────────────
--  집계 막대를 화면에서 확인하려면 태그가 붙은 후기가 있어야 한다. 개발 단계에서
--  "20명 이상만 노출" 규칙을 뺀 것도 같은 이유다(1~2명으로도 막대가 보인다).
--  id 가 아니라 author_nm 을 키로 쓴다 — 016 과 같은 패턴이고 재실행에 안전하다.
insert into review_tags (review_id, tag_code)
select r.id, v.tag_code
  from (values
    ('민지', 'barrier_free'), ('민지', 'silver'),
    ('도현', 'barrier_free'), ('도현', 'kids'),
    ('서연', 'barrier_free'), ('서연', 'parking'),
    ('준호', 'barrier_free'), ('준호', 'kind'),
    ('하은', 'barrier_free'), ('하은', 'parking'),
    ('지우', 'barrier_free'), ('지우', 'silver'),
    ('유나', 'parking'),      ('유나', 'value')
  ) as v(author_nm, tag_code)
  join reviews r on r.author_nm = v.author_nm
on conflict (review_id, tag_code) do nothing;

-- 재방문 의향도 명시값으로 심는다. 별점과 독립이라는 걸 데이터로도 보이기 위해
--  '하은'은 별점 4인데 재방문 의향 없음, '유나'는 미응답(null)으로 둔다 —
--  세 상태를 화면에서 다 확인할 수 있어야 한다.
--  값을 전부 지정하므로 재실행해도 항상 같은 상태로 수렴한다.
update reviews r set would_revisit = v.would_revisit
  from (values
    ('민지', true),  ('도현', true), ('서연', true),
    ('준호', true),  ('지우', true),
    ('하은', false),
    ('유나', null::boolean)
  ) as v(author_nm, would_revisit)
 where r.author_nm = v.author_nm;
