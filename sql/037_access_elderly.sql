-- 고령자 접근성 플래그 — 관광공사 5개 유형 중 우리가 빠뜨리고 있던 하나.
--
-- ── 왜 지금 생겼나
--  열린관광(access.visitkorea.or.kr)의 공식 분류는 **5개 유형**이다:
--    지체장애 · 시각장애 · 청각장애 · 영유아가족 · **고령자**
--  우리는 28속성을 앞의 넷으로만 묶어 왔다. 고령자 유형의 공식 항목은
--  "휠체어 대여 · 이동보조기기 대여" 두 가지인데, 그 데이터를 이미 갖고 있으면서도
--  wheelchair 컬럼을 지체장애 그룹에 묻어 두고 있었다. 새로 수집할 것은 없다.
--
-- ── 판정 기준 (기획 확정)
--  휠체어 대여 · 이동보조기기 대여 · 승강기 · 주차 중 **하나라도 있으면** 켠다.
--  공식 2항목만 쓰면 1,486곳(14.5%)에 그치는데, 대부분의 고령 여행자는 휠체어를 쓰지 않는다.
--  실제로 겪는 문제는 계단과 걷는 거리라서 승강기·주차를 함께 본다 → 6,231곳(60.7%).
--
--  ⚠️ OR 인 것이 다른 유형과 **일관된** 처리다. access_wheelchair 도 12개 속성 중 하나만
--     있으면 켜지고 그래서 90.3% 다. 이 플래그들은 "좋은 곳"이 아니라 **"그 유형의 정보가
--     있는 곳"** 을 뜻한다. 판단은 상세 화면의 원문이 한다.
--
--  ⚠️ 이동보조기기는 전용 컬럼이 없어 handicapetc 본문에서 찾는다 — 실측 3건뿐이라
--     사실상 휠체어·승강기·주차 세 항목이다. 컬럼이 생기면 이 조건을 옮기면 된다.
--
--  ⚠️ "대여불가" 같은 부정 표현(9건)을 걸러내지 않는다. 실물을 보면
--     "공연장은 대여불가하며 미술관에 1대 구비" 처럼 부분 가능인 경우가 대부분이라
--     정규식으로 자르면 오히려 틀린다. 상세 화면이 원문을 그대로 보여주므로 사용자가 읽는다.
--     (다른 네 유형도 같은 이유로 텍스트를 해석하지 않고 유무만 본다)
--
--  migrate 는 내용 해시로 재적용을 판단하므로 이 파일은 멱등이어야 한다.

alter table barrier_free add column if not exists access_elderly boolean not null default false;
create index if not exists idx_bf_elderly on barrier_free (access_elderly) where access_elderly;

-- 기존 행 백필. ingest:barrier-free 가 돌면 어차피 채워지지만, 수집기를 못 돌리는 환경에서도
--  마이그레이션만으로 스키마와 데이터가 맞아떨어져야 한다(032 와 같은 이유).
--  ⚠️ coalesce 가 필요하다. handicapetc 가 null 이면 `null ~ 정규식` 은 false 가 아니라 **null**
--     이고, `false or null` 도 null 이라 not null 컬럼에 넣다가 통째로 실패한다.
--     (이 파일을 처음 돌릴 때 실제로 그 에러로 롤백됐다)
update barrier_free b
   set access_elderly = (
         nullif(w.wheelchair, '') is not null
      or coalesce(w.handicapetc ~ '이동보조|전동스쿠터|스쿠터|보행보조', false)
      or nullif(w.elevator, '') is not null
      or nullif(w.parking, '') is not null)
  from kor_with_detail w
 where w.content_id = b.contentid
   and b.access_elderly is distinct from (
         nullif(w.wheelchair, '') is not null
      or coalesce(w.handicapetc ~ '이동보조|전동스쿠터|스쿠터|보행보조', false)
      or nullif(w.elevator, '') is not null
      or nullif(w.parking, '') is not null);
