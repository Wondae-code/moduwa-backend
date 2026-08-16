-- 플랜의 확정 여부 — "플랜은 초안이고, 일정에 추가하면 확정된다"(2026-08-16 기획 확정).
--
--  시안의 플랜 카드 ⋮ 에 있는 "일정에 추가"(553:135)가 이 상태를 바꾼다.
--  그전까지는 플랜 탭과 일정 탭이 같은 목록을 그대로 보고 있어 두 탭이 사실상 중복이었다.
--  이제 갈린다 — 플랜 탭은 confirmed_at 이 null 인 초안을, 일정 탭은 확정된 것을 본다.
--
--  boolean 이 아니라 timestamptz 인 이유: "확정됐다"보다 "언제 확정했다"가 늘 더 많은 것을
--  말해 준다. null 이 곧 초안이라 값 하나로 두 가지를 담는다. 나중에 "최근 확정한 여행"
--  같은 조회가 생겨도 컬럼을 더 붙일 필요가 없다.
--
--  ⚠️ 기본값을 주지 않는다. 이 컬럼이 생기기 전에 만들어진 플랜은 사용자가 확정한 적이 없으므로
--  초안으로 두는 것이 사실에 맞다. 일괄로 확정 처리하면 "확정했다"는 기록을 앱이 지어내는 셈이다.
alter table plans add column if not exists confirmed_at timestamptz;

-- 일정 탭이 "확정된 것만, 최근 여행부터"를 자주 묻는다.
create index if not exists plans_confirmed_idx
  on plans (author_id, confirmed_at, start_date desc);
