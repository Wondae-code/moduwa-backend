-- 슬러그 하나가 시군구 여러 개를 가리킬 수 있게 한다 — signgu_cd → signgu_cds text[]
--
-- ── 왜
--  일반구를 둔 시는 법정동 코드가 여러 개다. 슬러그가 코드를 하나만 들 수 있으면 그런 도시는
--  **반쪽만 추천된다.** 앱이 포항을 요청하며 발견했지만, 포항만의 문제가 아니었다:
--
--  ⚠️ **전주(jeonju)는 이미 깨진 채 서비스되고 있었다.** 전주시는 111(완산구)·113(덕진구)인데
--     034 가 111 만 넣었다. 그래서 덕진구 36곳이 통째로 빠졌고, 그중에는
--     **전북 인기 1위 한국도로공사 전주수목원 · 3위 전주동물원 · 9위 전주월드컵경기장**이 있다.
--     "전주 여행" 추천이 그 지역 1위 명소를 빼고 만들어지고 있었다. 에러가 아니라 조용한 누락이라
--     아무도 몰랐다 — 034 가 "후보 수를 세어 보고 넣으라" 고 한 이유가 이것이다.
--
--  2026-09-20 실측: barrier_free 에서 일반구로 갈라지는 시가 **16개**다(창원 5 · 화성 5 ·
--  수원 4 · 청주 4 · 용인/고양/성남/부천 3 · 전주/안산/천안/포항/안양 2 …). 포항만 특례로
--  처리하면 전주는 깨진 채 남고, 다음 슬러그마다 같은 벽을 만난다.
--
-- ── 후보 수 (034 의 규칙대로 세고 넣는다, 2026-09-20 · 사진 보유 기준)
--     포항 111만    27곳 — **음식 1곳**. 하루 세 끼를 못 채워 단독으로는 쓸 수 없다
--     포항 113만    30곳 — 관광지 11 · 음식 8
--     포항 111+113  57곳 — 관광지 24 · 음식 9 · 숙소 6   ← 안동 49 · 태안 52 보다 낫다
--     전주 111만    44곳 (현재)  →  111+113  71곳 (고침)
--
-- ⚠️ null 은 그대로 "그 시·도 전체" 를 뜻한다(시·도 슬러그 17개). 대시보드 지역 필터가
--    `signgu_cds is null` 로 시·도만 골라내므로 그 뜻을 바꾸면 안 된다.
--
--  migrate 는 내용 해시로 재적용을 판단하므로 이 파일은 멱등이어야 한다.

alter table region_slugs add column if not exists signgu_cds text[];

comment on column region_slugs.signgu_cds is
  '이 슬러그가 덮는 ldong_signgu_cd 목록. null 이면 그 시·도 전체. 일반구를 둔 시는 여러 개다.';

-- 구 컬럼이 아직 있으면 옮기고 지운다. 두 번째 실행부터는 이 블록을 건너뛴다.
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'region_slugs'
                and column_name = 'signgu_cd') then
    update region_slugs set signgu_cds = array[signgu_cd]
     where signgu_cd is not null and signgu_cds is null;
    alter table region_slugs drop column signgu_cd;
  end if;
end $$;

-- 전주 — 덕진구를 더한다(위 ⚠️).
update region_slugs set signgu_cds = array['111', '113'] where slug = 'jeonju';

-- 포항 — 남구(111) · 북구(113). 앱 시안 2/6 의 14개 지역 중 유일하게 빠져 있었다.
insert into region_slugs (slug, regn_cd, signgu_cds, label) values
  ('pohang', '47', array['111', '113'], '포항')
on conflict (slug) do update
  set regn_cd = excluded.regn_cd, signgu_cds = excluded.signgu_cds, label = excluded.label;
