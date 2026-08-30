-- 검색 정규화 — 띄어쓰기 무시(정규화 컬럼) + 오타 허용(자모 분해 트라이그램).
--
-- ── 실측이 말해준 것 (2026-08-31, 로컬 10,265곳)
--   · "경 복궁"·"황리단 길" → 0건. ILIKE 는 부분 문자열이 정확히 이어져야 잡는다.
--     → 정규화 컬럼(공백·기호 제거)으로 해결. 018·033 과 같은 정규화 규칙을 쓴다.
--   · "경북궁"(받침 오타) → 음절 트라이그램 유사도 0.14 — 임계값을 아무리 내려도
--     엉뚱한 "경북대학교박물관"(0.18)이 먼저 잡힌다. **음절 단위로는 못 푼다.**
--     한글 음절은 받침 하나만 달라도 통째로 다른 글자라 3글자 창이 전부 어긋난다.
--     → **자모 분해**로 해결: 경복궁=ㄱㅕㅇㅂㅗㄱㄱㅜㅇ, 경북궁=ㄱㅕㅇㅂㅜㄱㄱㅜㅇ —
--       9자 중 1자 차이가 되어 트라이그램이 제대로 작동한다.
--
-- ── 왜 generated column 인가
--   수집기가 채우는 방식(032 처럼)은 수집기·백필 두 곳이 같은 식을 알아야 한다.
--   생성 컬럼은 식이 스키마에 한 곳만 있고, 수집기는 손대지 않아도 된다.
--   ⚠️ 대신 함수를 고쳐도 기존 행이 재계산되지 않는다(쓰기 시점 계산). hangul_jamo 를
--      바꿀 일이 생기면 컬럼을 drop → add 해야 한다. 이 파일에 그 순서를 함께 두면 된다.
--
-- ── prod 반영 순서
--   migrate 만으로 끝난다 — 생성 컬럼이라 prod 의 기존 데이터에서 자동 계산된다.
--   ⚠️ push-data.sh 는 그 뒤에 돌려야 한다. 덤프의 생성 컬럼 DDL 이 hangul_jamo() 를
--      참조하는데 함수는 테이블 덤프에 포함되지 않는다 — migrate 가 먼저 만들어 둬야 한다.
--
--  ⚠️ CREATE INDEX CONCURRENTLY 를 쓰지 않는다 — 트랜잭션 안에서 실행할 수 없어 우리
--     migrate 에서 실패하고, 10,265행에서는 일반 생성이 밀리초라 필요도 없다.
--
--  migrate 는 내용 해시로 재적용을 판단하므로 이 파일은 전부 멱등이어야 한다.

-- 한글 음절 → 호환 자모 나열. 완성형 공식(0xAC00 + (초성×21 + 중성)×28 + 종성)의 역산이다.
--  한글 밖 문자는 그대로 통과시킨다(영숫자 검색어 대응).
create or replace function hangul_jamo(input text) returns text
language plpgsql immutable strict parallel safe as $$
declare
  result text := '';
  code int; sidx int;
  CHO  constant text[] := array['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
  JUNG constant text[] := array['ㅏ','ㅐ','ㅑ','ㅒ','ㅓ','ㅔ','ㅕ','ㅖ','ㅗ','ㅘ','ㅙ','ㅚ','ㅛ','ㅜ','ㅝ','ㅞ','ㅟ','ㅠ','ㅡ','ㅢ','ㅣ'];
  JONG constant text[] := array['','ㄱ','ㄲ','ㄳ','ㄴ','ㄵ','ㄶ','ㄷ','ㄹ','ㄺ','ㄻ','ㄼ','ㄽ','ㄾ','ㄿ','ㅀ','ㅁ','ㅂ','ㅄ','ㅅ','ㅆ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
begin
  for i in 1..length(input) loop
    code := ascii(substr(input, i, 1));
    if code between 44032 and 55203 then
      sidx := code - 44032;
      result := result || CHO[sidx / 588 + 1] || JUNG[(sidx % 588) / 28 + 1] || JONG[sidx % 28 + 1];
    else
      result := result || substr(input, i, 1);
    end if;
  end loop;
  return result;
end $$;

-- 정규화 규칙은 018·033 과 동일해야 한다 — 검색어 쪽(JS)도 같은 규칙을 쓴다.
alter table barrier_free add column if not exists title_norm text
  generated always as (regexp_replace(lower(coalesce(title, '')), '[^0-9a-z가-힣]', '', 'g')) stored;
alter table barrier_free add column if not exists addr1_norm text
  generated always as (regexp_replace(lower(coalesce(addr1, '')), '[^0-9a-z가-힣]', '', 'g')) stored;
alter table barrier_free add column if not exists title_jamo text
  generated always as (hangul_jamo(regexp_replace(lower(coalesce(title, '')), '[^0-9a-z가-힣]', '', 'g'))) stored;

create index if not exists idx_bf_title_norm_trgm on barrier_free using gin (title_norm gin_trgm_ops);
create index if not exists idx_bf_addr1_norm_trgm on barrier_free using gin (addr1_norm gin_trgm_ops);
create index if not exists idx_bf_title_jamo_trgm on barrier_free using gin (title_jamo gin_trgm_ops);

-- 검색 가중치 — 추천과 같은 테이블·같은 원칙(배포 없이 조정, do nothing 으로 운영값 보호).
--
--  ⚠️ 지표를 **둘 다** 쓰는 이유(실측):
--   · similarity(전체 일치)만: "아꾸아리움" 이 긴 제목("씨라이프부산아쿠아리움" 0.23)에서
--     희석되어 정답이 임계 밑으로 떨어진다.
--   · word_similarity(조각 일치)만: "경북궁" 의 오답("경북대학교박물관" 0.60)이 정답
--     ("경복궁" 0.54)을 이긴다 — 검색어가 긴 이름의 접두어로 통째로 들어있으면 과대평가된다.
--   → 후보 포함은 둘 중 하나(OR)로 느슨하게, **순위는 sim + mix×wsim** 으로 매긴다.
--     경복궁 .81 > 경북대박물관 .52 / 불국샤→경주 불국사도 회수됨. 전 케이스 분리 확인.
delete from recommend_weights where key = 'search.fuzzy_threshold';  -- 구명(단일 임계) 정리
insert into recommend_weights (key, value, note) values
  ('search.jamo_sim_threshold',  0.40, '자모 전체 유사도 포함 임계. 실측: 경복궁 0.54 / 오답 0.36 이하'),
  ('search.jamo_word_threshold', 0.50, '자모 조각 유사도 포함 임계. 실측: 정답 0.56~0.78 / 불갑사 0.44'),
  ('search.jamo_word_mix',       0.50, '순위 점수 = sim + mix×wsim'),
  ('search.addr_weight',         0.60, '주소 일치를 이름 일치보다 낮게 치는 배율')
on conflict (key) do nothing;
