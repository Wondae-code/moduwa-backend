-- AI 추천 코스 v1 의 기반 — 미리계산 신호 · 가중치 설정 · 지역 슬러그.
--
-- ── 왜 미리 계산하나
--  hub_rank(인기순위)와 tats_cnctr(혼잡도)는 둘 다 **이름 + 시군구**로만 우리 장소와 이어진다.
--  018 에서 검증한 정규화 매칭을 요청마다 돌리면 추천 한 번에 수십만 행을 훑게 되므로 굳혀 둔다.
--
-- ── ⚠️ 실측: 두 신호 모두 커버리지가 24% 다
--     hub_rank 매칭 2,444 / 10,265  ·  혼잡도 매칭 2,425 / 10,265
--     근본 원인은 018 주석과 같다 — 전국 "기준 관광지" 가 6,574곳뿐이라 음식점(2,532)·
--     쇼핑(1,568)·숙박(1,069)은 애초에 대상이 아니다.
--     그래서 **이 신호들을 필수로 쓰면 후보의 4분의 3이 사라진다.** 없을 때는 반드시
--     중립(가중치 0)으로 다뤄야 하고, 그 기준선을 recommend_weights.base_neutral 로 뺐다.
--
--  migrate 는 내용 해시로 재적용을 판단하므로 이 파일은 멱등이어야 한다.

-- ────────────────────────────────────────────────────────────────────
-- 1) 미리계산 신호
-- ────────────────────────────────────────────────────────────────────
alter table barrier_free add column if not exists hub_rank integer;
-- 혼잡도는 **날짜별** 값이라 등수를 굳힐 수 없다. 조인 키만 굳히고 rate 는 요청 시 날짜로 읽는다.
alter table barrier_free add column if not exists tats_nm  text;
alter table barrier_free add column if not exists tats_sgg text;
create index if not exists idx_bf_tats on barrier_free (tats_nm, tats_sgg) where tats_nm is not null;

-- 018 과 같은 정규화(소문자 · 한글/영숫자만)로 이름을 맞춘다. 부분일치는 쓰지 않는다 —
--  018 에서 표본의 25~30% 가 오탐이었고, 앵커가 틀리면 엉뚱한 장소의 추천이 나간다.
with bf as (
  select contentid,
         regexp_replace(lower(title), '[^0-9a-z가-힣]', '', 'g') as k,
         left(ldong_regn_cd, 2) || right(ldong_signgu_cd, 3) as sgg
    from barrier_free
   where title is not null and ldong_regn_cd is not null and ldong_signgu_cd is not null
),
hub as (
  select regexp_replace(lower(hub_tats_nm), '[^0-9a-z가-힣]', '', 'g') as k,
         signgu_cd as sgg, min(hub_rank) as rk
    from locgo_hub_records
   where base_ym = (select max(base_ym) from locgo_hub_records)
     and hub_tats_nm is not null and signgu_cd is not null
   group by 1, 2
)
update barrier_free b set hub_rank = hub.rk
  from bf join hub on hub.k = bf.k and hub.sgg = bf.sgg
 where b.contentid = bf.contentid and b.hub_rank is distinct from hub.rk;

with bf as (
  select contentid,
         regexp_replace(lower(title), '[^0-9a-z가-힣]', '', 'g') as k,
         left(ldong_regn_cd, 2) || right(ldong_signgu_cd, 3) as sgg
    from barrier_free
   where title is not null and ldong_regn_cd is not null and ldong_signgu_cd is not null
),
tc as (
  select regexp_replace(lower(t_ats_nm), '[^0-9a-z가-힣]', '', 'g') as k,
         signgu_cd as sgg, min(t_ats_nm) as nm
    from tats_cnctr where t_ats_nm is not null and signgu_cd is not null
   group by 1, 2
)
update barrier_free b set tats_nm = tc.nm, tats_sgg = tc.sgg
  from bf join tc on tc.k = bf.k and tc.sgg = bf.sgg
 where b.contentid = bf.contentid and b.tats_nm is distinct from tc.nm;

-- ────────────────────────────────────────────────────────────────────
-- 2) 가중치 설정 — 명세 5번의 "코드에 하드코딩하지 말고 설정으로 빼 달라" 요청
-- ────────────────────────────────────────────────────────────────────
--  값을 바꾸면 **배포 없이** 다음 요청부터 반영된다(서버가 짧게 캐시).
--  숫자는 전부 튜닝 전제의 시작점이고, 명세 5-3 의 지표를 보며 조정한다.
create table if not exists recommend_weights (
  key        text primary key,
  value      numeric not null,
  note       text,
  updated_at timestamptz not null default now()
);

insert into recommend_weights (key, value, note) values
  -- ── 기준 점수
  ('base.neutral',            50, '모든 후보의 출발점. hub_rank 가 없는 76% 가 여기서 시작한다'),
  ('base.hub_rank_max',       30, 'hub_rank 1위가 받는 최대 가산점(등수가 낮을수록 조금 받는다)'),
  ('base.has_image',           8, '카드에 쓸 사진이 있는가 — 없으면 추천 화면이 비어 보인다'),
  -- ── 동반자 신호 (1순위: 공식 데이터 / 2순위: 후기 태그)
  ('party.official_positive', 25, '공식 양성 신호. 아이=access_infant(3,000곳) · 반려동물=pet_tour(1,329곳)'),
  ('party.review_tag',        15, '후기 태그 1건당. 사용자 데이터가 쌓일수록 영향이 커진다'),
  ('party.review_tag_cap',    45, '후기 태그 가산 상한. 후기 많은 유명지가 전부 밀어내는 것을 막는다'),
  ('party.accessibility',     20, '효도여행에서 무장애 속성 보유(휠체어·이동편의)'),
  -- ── 혼잡도 (명세 3번: 혼잡 예상일엔 가벼운 일정)
  ('congestion.quiet_bonus',  10, '한산 예상일에 주요 명소를 배치할 때'),
  ('congestion.busy_penalty', 15, '혼잡 예상일에 주요 명소를 배치할 때 빼는 점수'),
  ('congestion.threshold',    70, '이 값(백분위) 이상이면 혼잡일로 본다'),
  -- ── 기타
  ('theme.match',             20, '고른 테마와 장소 유형이 맞을 때'),
  ('budget.match',            20, '숙박 가격대가 맞을 때'),
  ('diversity.same_type',    -10, '같은 유형이 하루에 반복될 때(호텔 상세에 호텔만 뜨는 문제 방지)')
on conflict (key) do nothing;   -- ⚠️ do update 가 아니다. 운영에서 조정한 값을 배포가 되돌리면 안 된다

-- ────────────────────────────────────────────────────────────────────
-- 3) 지역 슬러그 — 앱은 plans.region 에 'gyeongju' 같은 슬러그를 쓰는데 서버엔 매핑이 없었다
-- ────────────────────────────────────────────────────────────────────
--  추천은 지역 필터가 1단계라 이게 없으면 시작조차 못 한다.
--  ⚠️ 슬러그는 앱과 **합의된 목록**이어야 한다. 여기 없는 슬러그가 오면 추천이 조용히 전국을
--     뒤지는 대신 400 으로 알린다(코드로 보내는 길도 함께 열어 둔다).
create table if not exists region_slugs (
  slug      text primary key,
  regn_cd   text not null,          -- ldong_regn_cd
  signgu_cd text,                   -- ldong_signgu_cd. null 이면 시도 전체
  label     text not null
);

insert into region_slugs (slug, regn_cd, signgu_cd, label) values
  ('seoul',     '11', null,  '서울'),
  ('jongno',    '11', '110', '서울 종로'),
  ('gangneung', '51', '150', '강릉'),
  ('chuncheon', '51', '110', '춘천'),
  ('sokcho',    '51', '210', '속초'),
  ('pyeongchang','51','760', '평창'),
  ('gyeongju',  '47', '130', '경주'),
  ('andong',    '47', '170', '안동'),
  ('jeju',      '50', null,  '제주'),
  ('jejusi',    '50', '110', '제주시'),
  ('seogwipo',  '50', '130', '서귀포'),
  ('busan',     '26', null,  '부산'),
  ('incheon',   '28', null,  '인천'),
  ('daegu',     '27', null,  '대구'),
  ('daejeon',   '30', null,  '대전'),
  ('gwangju',   '29', null,  '광주'),
  ('ulsan',     '31', null,  '울산'),
  ('sejong',    '36', null,  '세종'),
  ('gyeonggi',  '41', null,  '경기'),
  ('gapyeong',  '41', '820', '가평'),
  ('gangwon',   '51', null,  '강원'),
  ('chungbuk',  '43', null,  '충북'),
  ('chungnam',  '44', null,  '충남'),
  ('jeonbuk',   '52', null,  '전북'),
  ('jeonnam',   '46', null,  '전남'),
  ('gyeongbuk', '47', null,  '경북'),
  ('gyeongnam', '48', null,  '경남'),
  ('yeosu',     '46', '130', '여수'),
  ('jeonju',    '52', '110', '전주'),
  ('tongyeong', '48', '220', '통영'),
  ('geoje',     '48', '310', '거제'),
  ('namhae',    '48', '840', '남해')
on conflict (slug) do nothing;
