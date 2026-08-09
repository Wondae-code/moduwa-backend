-- 새 플랜 플로우 4/6·5/6 입력 — 선호 테마와 예산.
--  기획 스케치("4/6~6/6 단계는 아래 참고하여 비슷한 디자인으로")에서 나온 두 값이다.
--
--  party(jsonb)에 얹지 않고 별도 컬럼으로 두는 이유: party 는 "누가 가는가"(연령·동반자·이동수단)이고
--  이 둘은 "어떻게 가고 싶은가"(취향·예산)라 성격이 다르다. 나중에 "예산 중간대 플랜" 같은 조회가
--  생기면 jsonb 안에 묻힌 값보다 컬럼이 다루기 쉽다.

-- 선호 테마. 코드 배열이고 표시 문구는 앱이 붙인다(GET /v1/plan-options 로 내려준다).
--  배열 원소를 DB 에서 검증하지 않는 대신 API 가 화이트리스트로 막는다 — 배열 원소 check 는
--  표현이 번잡한 데 비해, 값이 들어오는 경로가 PUT 하나뿐이라 API 쪽 검증으로 충분하다.
alter table plans add column if not exists themes text[] not null default '{}';

-- 예산. 값이 셋뿐인 닫힌 집합이라 DB 에서도 막는다.
--  null 은 "고르지 않음"이다 — 스케치의 "다음에 할래요"(건너뛰기)가 그 상태를 만든다.
alter table plans add column if not exists budget text
  check (budget is null or budget in ('low', 'medium', 'high'));

-- "당일치기만 즐길게요" 체크(4/6 하단). 날짜 범위와 별개로 사용자가 밝힌 선호라 따로 둔다 —
--  startDate = endDate 로 유추하면 "하루짜리 일정"과 "당일치기를 원한다"를 구분할 수 없다.
alter table plans add column if not exists day_trip_only boolean not null default false;
