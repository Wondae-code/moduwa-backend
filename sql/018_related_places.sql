-- 무장애 장소별 "함께 가볼만한 곳" 미리계산 테이블 (iOS 장소 상세 하단 가로 캐러셀, 피그마 352:54)
--
-- ── 왜 미리 계산하나
--  tar_rlte_records(연관관광지) 는 351만 행이고, 그 키(t_ats_cd = 한국관광데이터랩 관광지코드)와
--  barrier_free.contentid(TourAPI content_id) 는 체계가 달라 "이름 + 시군구코드" 로 매칭해야 한다.
--  조회 시점에 매칭하면 느리므로 무장애 장소 1만여 건에 대해 결과를 굳혀 둔다.
--
-- ── 측정 결과 (로컬, barrier_free 10,248건 / tar_rlte_records base_ym=202605 171,307행)
--  · 연관관광지(tar_rlte) 단독은 커버리지가 낮다
--      - 무장애 장소가 "기준 관광지(t_ats_cd)" 로 존재:      1,593건 = 15.5%  (정확 일치)
--                                                          1,831건 = 17.9%  (괄호·시군구접두어 제거까지)
--        → 근본 원인: 전국 기준 관광지가 6,574곳뿐. 무장애 장소의 다수(음식점 2,519 / 숙박 1,067 등)는
--          애초에 기준 관광지가 될 수 없다.
--      - 연관 관광지(rlte_tats_nm) → kor_poi 매칭률: 37.2% (관광지 51.9% / 숙박 33.9% / 음식 24.1%)
--      - 역방향(무장애 장소가 rlte 쪽으로 등장)까지 합쳐도 앵커 커버리지 3,272건 = 31.9%
--      - 추천 대상을 barrier_free(이미지 보유)로 제한하면 최종 ≥3장 확보: 2,186건 = 21.3%
--        (추천 카드는 탭하면 상세로 가야 하고 상세 라우트는 /v1/barrier-free/:contentId 뿐이므로
--         추천 대상은 barrier_free 안에 있어야 한다. kor_poi 전체를 쓸 수 없는 이유.)
--  · 근접 폴백(같은 시군구 + 같은 contenttypeid + 이미지, 거리순)은 확실히 동작한다
--      - ≥3장 확보: 8,838건 = 86.2% / 같은 시군구(타입 무관)까지 허용하면 10,235건 = 99.9%
--  · 품질은 tar_rlte 쪽이 확실히 낫다 (같은 시군구를 벗어난 실제 동반방문 코스를 잡아낸다)
--      국립중앙박물관 → 창경궁·국립고궁박물관·서대문형무소역사관·전쟁기념관 (tar_rlte)
--                     vs 용산도시기억전시관·아모레퍼시픽미술관·대원뮤지엄 (근접)
--
-- ── 결론: 하이브리드 (tar_rlte 우선 → 부족분을 근접 폴백으로 채움)
--    최종 커버리지: 10,248/10,248 = 100% 가 ≥3장, 10,098건(98.5%)은 10장 만석 (나머지는 8~9장)
--    유래별 행 수: rlte 19,116 / nearby 82,710 / nearby_region 494 / nearby_national 10 (합 102,330)
--    앵커 기준으로는 3,528건(34.4%)이 최소 1장을 tar_rlte 에서 받는다 — 나머지는 순수 근접 폴백.
--    거리 분포(중위/95분위): nearby 2.0km/16.5km, rlte 6.7km/34.0km
--    source 컬럼으로 유래를 남긴다:
--      'rlte'            연관관광지(동반방문) 유래 — 가장 품질이 좋다
--      'nearby'          같은 시군구 근접 (같은 contenttypeid 우선)
--      'nearby_region'   같은 광역시도 근접 (시군구 안에 짝이 부족할 때)
--      'nearby_national' 좌표 기준 전국 최근접 (광역시도 안에도 짝이 없을 때. 현재 10행)
--
-- ── 운영 주의
--  · barrier_free 는 ingest:barrier-free 가 매일 갱신한다. 이 테이블은 그 파생물이므로
--    ingest 이후 `npm run migrate` 를 다시 돌려 재계산해야 최신 상태가 된다(전체 delete + insert, 멱등).
--  · prod 반영 시 scripts/push-data.sh 의 TABLES 에 related_places 를 추가해야 한다(현재 미포함).
--  · API 라우트(GET /v1/barrier-free/:contentId/related)는 이 파일에서 만들지 않는다. 검증된 쿼리:
--      select b.contentid, b.title, b.addr1, b.firstimage, b.contenttypeid,
--             b.has_access, b.access_wheelchair, b.access_visual, b.access_hearing, b.access_infant,
--             r.rank, r.source
--        from related_places r
--        join barrier_free b on b.contentid = r.related_content_id
--       where r.content_id = $1
--       order by r.rank
--       limit $2;                       -- idx_rp_content 사용, 실측 0.14ms
--  · 재계산 소요시간: 로컬에서 약 3.5초 (npm run migrate 전체가 3.9초)

create table if not exists related_places (
  content_id         text    not null,
  related_content_id text    not null,
  rank               integer not null,
  source             text    not null,
  primary key (content_id, related_content_id)
);
create index if not exists idx_rp_content on related_places (content_id, rank);

-- ────────────────────────────────────────────────────────────────────
-- 재계산 (매 실행마다 전체 재구성 — 멱등)
-- ────────────────────────────────────────────────────────────────────

-- 1) 시군구코드 → 시군구명. barrier_free 는 ldong_regn_cd(2자리)+ldong_signgu_cd(3자리),
--    tar_rlte_records 는 signgu_cd(5자리)를 쓴다. 세종(36110/36110)만 예외라 left/right 로 정규화한다.
drop table if exists tmp_sgg_nm;
create temporary table tmp_sgg_nm as
  select sgg, min(nm) as nm from (
    select signgu_cd as sgg, signgu_nm as nm
      from tar_rlte_records
     where base_ym = (select max(base_ym) from tar_rlte_records) and signgu_nm is not null
    union all
    select left(rlte_regn_cd, 2) || right(rlte_signgu_cd, 3), rlte_signgu_nm
      from tar_rlte_records
     where base_ym = (select max(base_ym) from tar_rlte_records)
       and rlte_regn_cd is not null and rlte_signgu_cd is not null and rlte_signgu_nm is not null
  ) x
  group by sgg;
create unique index on tmp_sgg_nm (sgg);
analyze tmp_sgg_nm;

-- 1-b) 시군구코드 별칭. barrier_free(TourAPI) 는 2026년 통합을 반영해 전남+광주를
--      '전남광주통합특별시'(regn 12) 로 내려주는데(814건), tar_rlte_records 는 아직
--      전라남도 46 / 광주광역시 29 를 쓴다. 코드가 어긋나 이 814건은 연관관광지 매칭률이 0% 였다.
--      addr1 의 시군구명으로 tar_rlte 쪽 코드를 찾아 잇는다.
--      · 이름이 전국에서 유일하면 그대로 채택 (목포시 → 46110 …)
--      · 동구/서구/남구/북구처럼 중복되면 addr1 첫 토큰에 광역시도명 앞 2글자가 들어있는 후보만 채택
--        ('전남광주통합특별시' ⊃ '광주' → 광주광역시 동구 29110, 부산·대구·인천·대전·울산 동구는 탈락)
drop table if exists tmp_sgg_alias;
create temporary table tmp_sgg_alias as
  with rl_sgg as (
    select distinct signgu_cd as sgg, signgu_nm as nm, area_nm
      from tar_rlte_records
     where base_ym = (select max(base_ym) from tar_rlte_records) and signgu_nm is not null
  ),
  orphan as (
    select distinct left(ldong_regn_cd, 2) || right(ldong_signgu_cd, 3) as sgg,
           split_part(addr1, ' ', 2) as nm,
           split_part(addr1, ' ', 1) as area_txt
      from barrier_free
     where ldong_regn_cd is not null and ldong_signgu_cd is not null and addr1 is not null
       and left(ldong_regn_cd, 2) || right(ldong_signgu_cd, 3) not in (select sgg from rl_sgg)
  ),
  cand as (
    select o.sgg as bf_sgg, o.area_txt, r.sgg as rl_sgg, r.area_nm,
           count(*) over (partition by o.sgg, o.nm) as n_all
      from orphan o join rl_sgg r on r.nm = o.nm
  )
  select bf_sgg, min(rl_sgg) as rl_sgg
    from (
      select bf_sgg, rl_sgg from cand where n_all = 1
      union all
      select bf_sgg, rl_sgg from cand where n_all > 1 and position(left(area_nm, 2) in area_txt) > 0
    ) x
   group by bf_sgg
  having count(distinct rl_sgg) = 1;
create unique index on tmp_sgg_alias (bf_sgg);
analyze tmp_sgg_alias;

-- 2) 무장애 장소 정규화. 좌표 sentinel 값(117.99/19.69 등 한반도 밖) 16건은 거리 계산에서 배제한다.
drop table if exists tmp_bf;
create temporary table tmp_bf as
  select b.contentid,
         coalesce(al.rl_sgg, left(b.ldong_regn_cd, 2) || right(b.ldong_signgu_cd, 3)) as sgg,
         left(coalesce(al.rl_sgg, left(b.ldong_regn_cd, 2) || right(b.ldong_signgu_cd, 3)), 2) as regn,
         b.contenttypeid,
         b.has_image,
         b.mapx, b.mapy,
         (b.mapx between 124 and 132 and b.mapy between 33 and 39) as coord_ok,
         -- k1: 원문 정규화 / k2: 대괄호·소괄호 내용 제거 후 정규화
         regexp_replace(lower(b.title), '[^0-9a-z가-힣]', '', 'g') as k1,
         regexp_replace(lower(regexp_replace(regexp_replace(b.title, '\[[^]]*\]', '', 'g'), '\([^)]*\)', '', 'g')),
                        '[^0-9a-z가-힣]', '', 'g') as k2
    from barrier_free b
    left join tmp_sgg_alias al
           on al.bf_sgg = left(b.ldong_regn_cd, 2) || right(b.ldong_signgu_cd, 3)
   where b.title is not null and b.ldong_regn_cd is not null and b.ldong_signgu_cd is not null
     -- ⚠️ **원천이 비어 있으면 여기서 멈춘다.** tar_rlte_records(357만행)는 로컬 전용이라
     --    prod 에는 테이블만 있고 비어 있다. 그대로 두면 8단계가 barrier_free 만으로 근접
     --    폴백을 채워서, prod 의 고품질 결과(실제 동반방문 유래 'rlte')를 **단순 거리순으로
     --    교체해 버린다.** 데이터가 사라지진 않지만 품질이 조용히 내려앉는 더 나쁜 형태다.
     --    (prod 의 related_places 는 push-data.sh 가 실어 보낸 것이 소스다)
     --  tmp_bf 를 비우면 이후 모든 단계가 빈 채로 흘러 **빠르고 안전하다** — 실제로 prod 에서
     --  이 계산이 10,265곳을 대상으로 몇 분씩 돌고 있었다.
     and exists (select 1 from tar_rlte_records limit 1);
create unique index on tmp_bf (contentid);
create index on tmp_bf (sgg)  where has_image;
create index on tmp_bf (regn) where has_image;
analyze tmp_bf;

-- 3) 매칭 키 테이블 (장소 1건당 1~3개 키). 세 번째 키 = k2 에서 선행 시군구명 제거 ('경주불국사' → '불국사').
--    부분 문자열(LIKE '%..%') 매칭은 일부러 쓰지 않는다 — '오라카이 청계산 호텔'↔'청계산',
--    '미쏘 타임스퀘어점'↔'타임스퀘어', '독일마을공식기념품판매점'↔'독일마을' 처럼
--    표본의 25~30% 가 오탐이었고, 앵커가 틀리면 "다른 장소의 추천"이 노출되는 최악의 실패다.
drop table if exists tmp_bf_key;
create temporary table tmp_bf_key as
  select distinct contentid, sgg, k from (
    select contentid, sgg, k1 as k from tmp_bf
    union all
    select contentid, sgg, k2 from tmp_bf
    union all
    select b.contentid, b.sgg, regexp_replace(b.k2, '^' || s.short_nm, '')
      from tmp_bf b
      join (select sgg, regexp_replace(nm, '[시군구]$', '') as short_nm from tmp_sgg_nm) s on s.sgg = b.sgg
     where length(s.short_nm) >= 2
       and b.k2 like s.short_nm || '%'
       and length(b.k2) - length(s.short_nm) >= 3
  ) x
  where k <> '';
create index on tmp_bf_key (k, sgg);
analyze tmp_bf_key;

-- 4) 최신 스냅샷의 관광지코드(기준·연관 양쪽) → 키
drop table if exists tmp_ats;
create temporary table tmp_ats as
  select ats_cd, sgg, min(nm) as nm from (
    select t_ats_cd as ats_cd, signgu_cd as sgg, t_ats_nm as nm
      from tar_rlte_records
     where base_ym = (select max(base_ym) from tar_rlte_records)
       and t_ats_nm is not null and signgu_cd is not null
    union all
    select rlte_tats_cd, left(rlte_regn_cd, 2) || right(rlte_signgu_cd, 3), rlte_tats_nm
      from tar_rlte_records
     where base_ym = (select max(base_ym) from tar_rlte_records)
       and rlte_tats_nm is not null and rlte_regn_cd is not null and rlte_signgu_cd is not null
  ) x
  group by ats_cd, sgg;
create index on tmp_ats (ats_cd);
analyze tmp_ats;

drop table if exists tmp_ats_key;
create temporary table tmp_ats_key as
  select distinct ats_cd, sgg, k from (
    select ats_cd, sgg, regexp_replace(lower(nm), '[^0-9a-z가-힣]', '', 'g') as k from tmp_ats
    union all
    select ats_cd, sgg,
           regexp_replace(lower(regexp_replace(regexp_replace(nm, '\[[^]]*\]', '', 'g'), '\([^)]*\)', '', 'g')),
                          '[^0-9a-z가-힣]', '', 'g')
      from tmp_ats
    union all
    select a.ats_cd, a.sgg, regexp_replace(regexp_replace(lower(a.nm), '[^0-9a-z가-힣]', '', 'g'), '^' || s.short_nm, '')
      from tmp_ats a
      join (select sgg, regexp_replace(nm, '[시군구]$', '') as short_nm from tmp_sgg_nm) s on s.sgg = a.sgg
     where length(s.short_nm) >= 2
       and regexp_replace(lower(a.nm), '[^0-9a-z가-힣]', '', 'g') like s.short_nm || '%'
       and length(regexp_replace(lower(a.nm), '[^0-9a-z가-힣]', '', 'g')) - length(s.short_nm) >= 3
  ) x
  where k <> '';
create index on tmp_ats_key (k, sgg);
analyze tmp_ats_key;

-- 5) 관광지코드 → 무장애 contentid 매핑 (같은 시군구 안에서 키 완전 일치만)
drop table if exists tmp_ats_map;
create temporary table tmp_ats_map as
  select distinct a.ats_cd, b.contentid
    from tmp_ats_key a
    join tmp_bf_key b on b.k = a.k and b.sgg = a.sgg;
create index on tmp_ats_map (ats_cd);
analyze tmp_ats_map;

-- 6) 연관관광지 엣지 (정방향 + 역방향). 추천 대상은 이미지 보유 무장애 장소만.
drop table if exists tmp_rlte_edge;
create temporary table tmp_rlte_edge as
  with hit as (
    select mb.contentid as base_cid, mr.contentid as rel_cid, r.rlte_rank
      from tar_rlte_records r
      join tmp_ats_map mb on mb.ats_cd = r.t_ats_cd
      join tmp_ats_map mr on mr.ats_cd = r.rlte_tats_cd
     where r.base_ym = (select max(base_ym) from tar_rlte_records)
  )
  select content_id, related_content_id, min(rlte_rank) as rk
    from (
      select base_cid as content_id, rel_cid as related_content_id, rlte_rank from hit
      union all
      -- 역방향: 우리 장소가 연관 쪽에 등장하면 그 기준 관광지도 "함께 방문한 곳"이다
      select rel_cid, base_cid, rlte_rank from hit
    ) e
   where content_id <> related_content_id
     and exists (select 1 from tmp_bf t where t.contentid = e.related_content_id and t.has_image)
   group by content_id, related_content_id;

-- 7) rlte 후보 상위 10. barrier_free 에 동명이인(같은 title, 다른 contentid)이 있어 캐러셀에
--    같은 이름이 두 번 보이는 일이 있었다 → 정규화 이름(k2) 기준으로 1건만 남긴다.
--
-- ⚠️ **유형 위생을 rlte 에도 적용한다(2026-08-26 추가).** 8단계(근접 폴백)에는 진작 있었는데
--    이쪽은 관광공사 연관관광지 순위를 그대로 써서, 볼거리 앵커에 쇼핑·음식이 17.6% 나 섞였다
--    (근접 폴백은 2.1%). 실제로 이런 카드가 나갔다 —
--      해운대수목원 → 신세계백화점 센텀시티점 · 신세계사이먼 아울렛 · 롯데프리미엄아울렛 ·
--                     부산새벽시장 · 롯데백화점 부산본점 · 충무동 새벽시장 (전부 rlte)
--    부산 관광객이 통계상 둘 다 방문하는 것은 사실이지만 "함께 가볼만한 곳" 카드로는 아니다.
--    기획 피드백 "뜨는 장소들이 생뚱맞다" 의 실제 원인이 이것이었다.
--
--    거리도 함께 본다. rlte 는 중위 6.7km · 14% 가 20km 초과인데(근접은 2.5km · 2.6%),
--    동반방문 통계라 멀 수 있는 것은 맞다. 그래서 **자르지 않고 순위만 뒤로 민다** —
--    가까운 좋은 후보가 있으면 그쪽이 앞에 오고, 없으면 먼 것이라도 쓴다.
drop table if exists tmp_pick;
create temporary table tmp_pick as
  select content_id, related_content_id, rn as rank, 'rlte'::text as source
    from (
      select d.content_id, d.related_content_id,
             row_number() over (partition by d.content_id order by d.pri, d.rk, d.related_content_id) as rn
        from (
          select e.content_id, e.related_content_id, e.rk,
                 -- 유형 위생 + 거리. 8단계의 pri 와 같은 사고방식이다.
                 (case
                    -- 볼거리 앵커에 쇼핑이 오는 것이 가장 나쁘다(백화점·아울렛 도배)
                    when a.contenttypeid in ('12','14','15','28') and t.contenttypeid = '38' then 30
                    when a.contenttypeid in ('12','14','15','28') and t.contenttypeid = '39' then 20
                    -- 볼거리끼리는 우대
                    when a.contenttypeid in ('12','14','15','28')
                     and t.contenttypeid in ('12','14','15','28') then 0
                    else 10
                  end)
                 + (case when a.coord_ok and t.coord_ok then
                      least(20, floor(sqrt(power((t.mapx-a.mapx)*cos(radians((a.mapy+t.mapy)/2))*111.32,2)
                                         + power((t.mapy-a.mapy)*110.57,2)) / 5)::int)
                    else 4 end) as pri,
                 row_number() over (partition by e.content_id, t.k2 order by e.rk, e.related_content_id) as dedup
            from tmp_rlte_edge e
            join tmp_bf t on t.contentid = e.related_content_id
            join tmp_bf a on a.contentid = e.content_id
        ) d
       where d.dedup = 1
    ) z
   where rn <= 10;
create index on tmp_pick (content_id, related_content_id);
analyze tmp_pick;

-- 8) 근접 폴백으로 10장까지 채운다.
--    1차 정렬은 같은 시군구 여부, 2차는 콘텐츠 타입, 3차는 거리다.
--    타입 우선순위는 "그냥 같은 타입" 이 아니다 — 호텔 상세에 다른 호텔 10개를 깔면
--    '함께 가볼만한 곳'이 아니라 경쟁 숙소 목록이 된다(실제로 '써미트 호텔 서울 → 호텔 10개'가 나왔다).
--    그래서 볼거리 타입(12 관광지 / 14 문화시설 / 15 축제 / 28 레포츠)을 먼저 올리고,
--    앵커도 볼거리면 같은 타입을 가장 먼저 둔다. 쇼핑(38)은 한 단계 아래 — 롯데몰 입점 매장이
--    한꺼번에 딸려 나와 카드가 '롯데몰 ○○점' 으로 도배되는 일이 있었다. 음식(39)·숙박(32)은 맨 뒤.
drop table if exists tmp_need;
create temporary table tmp_need as
  select b.contentid, b.sgg, b.regn, b.contenttypeid, b.mapx, b.mapy, b.coord_ok,
         10 - coalesce(p.n, 0) as need
    from tmp_bf b
    left join (select content_id, count(*) n from tmp_pick group by content_id) p on p.content_id = b.contentid
   where 10 - coalesce(p.n, 0) > 0;
create unique index on tmp_need (contentid);
analyze tmp_need;

insert into tmp_pick (content_id, related_content_id, rank, source)
select content_id, related_content_id, rank, source from (
select n.contentid as content_id, c.contentid as related_content_id,
       (10 - n.need) + row_number() over (partition by n.contentid order by c.pri, c.d, c.contentid) as rank,
       case when c.pri < 10 then 'nearby' else 'nearby_region' end as source,
       row_number() over (partition by n.contentid order by c.pri, c.d, c.contentid) as rn,
       n.need as need
  from tmp_need n
  join lateral (
    select t.contentid,
           (case when t.sgg = n.sgg then 0 else 10 end)
           + (case
                when t.contenttypeid in ('12', '14', '15', '28')
                     and t.contenttypeid = n.contenttypeid then 0   -- 관광지↔관광지
                when t.contenttypeid in ('12', '14', '15', '28') then 1
                when t.contenttypeid = '38' then 2                  -- 쇼핑: 몰 입점 매장이 몰려 나와 한 단계 아래
                when t.contenttypeid = n.contenttypeid then 3
                else 4
              end) as pri,
           case when n.coord_ok and t.coord_ok
                then sqrt(power((t.mapx - n.mapx) * cos(radians((n.mapy + t.mapy) / 2)) * 111.32, 2)
                        + power((t.mapy - n.mapy) * 110.57, 2))
                else 99999 end as d
      from tmp_bf t
     where t.has_image
       and t.regn = n.regn
       and t.contentid <> n.contentid
       and not exists (select 1 from tmp_pick p
                        where p.content_id = n.contentid and p.related_content_id = t.contentid)
       and not exists (select 1 from tmp_pick p
                        join tmp_bf b2 on b2.contentid = p.related_content_id
                       where p.content_id = n.contentid and b2.k2 = t.k2)
     order by pri, d, t.contentid
     limit 10
  ) c on true
) z
 where z.rn <= z.need;

-- 9) 최후 폴백: 같은 광역시도에 짝이 없는 장소 (광주광역시는 무장애 장소가 2건뿐이고 그중
--    이미지 보유가 1건이라 도 단위로도 채울 수 없다) + ldong 코드가 비어 8단계에서 빠진 장소.
--    좌표만 믿고 전국에서 100km 이내 최근접을 채운다.
drop table if exists tmp_need2;
create temporary table tmp_need2 as
  select b.contentid, b.mapx, b.mapy,
         10 - coalesce(p.n, 0) as need
    from barrier_free b
    left join (select content_id, count(*) n from tmp_pick group by content_id) p on p.content_id = b.contentid
   where 10 - coalesce(p.n, 0) > 0
     and b.mapx between 124 and 132 and b.mapy between 33 and 39;
analyze tmp_need2;

insert into tmp_pick (content_id, related_content_id, rank, source)
select content_id, related_content_id, rank, source from (
select n.contentid as content_id, c.contentid as related_content_id,
       (10 - n.need) + row_number() over (partition by n.contentid order by c.d, c.contentid) as rank,
       'nearby_national'::text as source,
       row_number() over (partition by n.contentid order by c.d, c.contentid) as rn,
       n.need as need
  from tmp_need2 n
  join lateral (
    select t.contentid,
           sqrt(power((t.mapx - n.mapx) * cos(radians((n.mapy + t.mapy) / 2)) * 111.32, 2)
              + power((t.mapy - n.mapy) * 110.57, 2)) as d
      from tmp_bf t
     where t.has_image and t.coord_ok and t.contentid <> n.contentid
       and t.mapx between n.mapx - 1.2 and n.mapx + 1.2
       and t.mapy between n.mapy - 0.9 and n.mapy + 0.9
       and not exists (select 1 from tmp_pick p
                        where p.content_id = n.contentid and p.related_content_id = t.contentid)
       and not exists (select 1 from tmp_pick p
                        join tmp_bf b2 on b2.contentid = p.related_content_id
                       where p.content_id = n.contentid and b2.k2 = t.k2)
     order by d, t.contentid
     limit 10
  ) c on true
) z
 where z.rn <= z.need and z.rank <= 10;

-- 10) 최종 적재. 여기서 한 번 더 정규화 이름(k2) 기준 중복을 걷어내고 rank 를 1..N 으로 다시 매긴다
--     (8·9단계는 배치 안에서 서로를 못 보므로 같은 이름이 한 배치에 두 번 들어올 수 있다).
-- ⚠️ 바꿀 내용이 있을 때만 지운다(2단계의 원천 확인과 짝을 이루는 마지막 방어선).
do $guard$
begin
  if not exists (select 1 from tmp_pick limit 1) then
    raise notice '[018] 계산 결과가 비어 기존 related_places 를 유지합니다';
    return;
  end if;

delete from related_places;
insert into related_places (content_id, related_content_id, rank, source)
select content_id, related_content_id, rank, source
  from (
    select content_id, related_content_id, source,
           row_number() over (partition by content_id order by rank) as rank
      from (
        select p.content_id, p.related_content_id, p.source, p.rank,
               row_number() over (partition by p.content_id, b.k2 order by p.rank) as dedup
          from tmp_pick p
          join tmp_bf b on b.contentid = p.related_content_id
      ) d
     where d.dedup = 1
  ) z
 where rank <= 10
 order by content_id, rank;
end $guard$;

analyze related_places;
