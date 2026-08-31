-- "덜 붐볐으면 좋겠어요"(시안 4/6) 를 골랐을 때의 혼잡도 가중치.
--
--  기본 가중치(congestion.busy_penalty 15 / quiet_bonus 10)는 그대로 두고, 사용자가 명시적으로
--  고른 경우에만 이 값으로 갈아탄다. 혼잡도를 아예 무시하던 것을 켜는 스위치가 아니라
--  **같은 방향으로 더 세게 미는** 값이다.
--
--  ⚠️ 무한정 키우면 안 된다. 혼잡도는 커버리지가 24% 뿐이어서(033 주석), 감점이 지나치면
--     "혼잡도를 아는 유명 관광지" 가 전부 밀려나고 정보가 없는 장소만 남는다 —
--     모르는 것에 유리하게 작용하는 역전이 생긴다. 기본값의 2배 남짓으로 둔 이유다.
--
--  do nothing 이다 — 운영에서 조정한 값을 배포가 되돌리면 안 된다(033 과 같은 규칙).
insert into recommend_weights (key, value, note) values
  ('congestion.avoid_busy_penalty', 35, 'avoidCrowds=true 일 때 혼잡일 감점(기본 15)'),
  ('congestion.avoid_quiet_bonus',  22, 'avoidCrowds=true 일 때 한산일 보너스(기본 10)')
on conflict (key) do nothing;
