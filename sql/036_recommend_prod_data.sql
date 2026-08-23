-- 추천이 prod 에서도 제대로 돌게 한다 — 혼잡도 집계 + 파생 테이블 보호.
--
-- ── 문제
--  추천은 로컬에서 잘 나오는데 prod 결과가 눈에 띄게 나빴다. 원인은 **원천 데이터가 prod 에
--  없다는 것**이다. push-data.sh 는 barrier_free 등 7개만 옮기고 tats_cnctr(혼잡도)·
--  kakao_place(카페·식사시간대)는 대상이 아니다. 그래서 prod 에서는 혼잡도가 항상 null 이고
--  아침 자리에 횟집이 들어갔다.
--
-- ── 왜 tats_cnctr 를 통째로 보내지 않나
--  440MB 다(raw 컬럼만 112MB). 그런데 추천이 실제로 읽는 것은 **지역·날짜별 평균** 하나뿐이다.
--  미리 집계하면 17개 시도 × 77일 ≈ 1,300행으로 줄고, 요청마다 66만 행을 훑던 것도 없어진다.
--  ⚠️ locgo_hub_records(394MB)는 아예 보낼 필요가 없다 — 요청 시점에 읽히지 않고,
--     결과인 hub_rank 는 barrier_free 컬럼에 실려 함께 간다.
--
--  migrate 는 내용 해시로 재적용을 판단하므로 이 파일은 멱등이어야 한다.

create table if not exists tats_region_daily (
  regn_cd   text not null,
  base_ymd  text not null,
  rate      numeric(6,2) not null,
  primary key (regn_cd, base_ymd)
);

-- ⚠️ **소스가 비어 있으면 손대지 않는다.** prod 에는 tats_cnctr 가 (테이블은 있고) 비어 있어서,
--    무조건 delete + insert 로 짜면 push-data.sh 로 실어 보낸 집계가 다음 migrate 때 지워진다.
--    018(related_places)이 정확히 그 구조라 같은 위험이 있다 — 아래 별도 가드 참고.
do $$
begin
  if exists (select 1 from tats_cnctr limit 1) then
    delete from tats_region_daily;
    insert into tats_region_daily (regn_cd, base_ymd, rate)
    select left(signgu_cd, 2), base_ymd, avg(cnctr_rate)::numeric(6,2)
      from tats_cnctr
     where signgu_cd is not null and base_ymd is not null
     group by 1, 2;
  end if;
end $$;
