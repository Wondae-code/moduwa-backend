-- 무장애 조사를 받지 않은 음식점 풀 — 추천의 식사·카페 자리를 채우는 후보.
--
-- ── 왜 별도 테이블인가
--  추천(038)이 kor_poi 를 직접 읽는데, 그 테이블은 **187MB**(raw 컬럼만 41MB)라 관리형 DB 로
--  옮기기 부담스럽다. 정작 추천이 쓰는 것은 `service='kor' · 음식점 · 사진 보유` **9,865행**뿐이다.
--  추려서 굳히면 몇 MB 로 줄고, push-data.sh 로 실어 보낼 수 있다.
--  (036 에서 tats_cnctr 440MB 를 1,300행 집계로 줄인 것과 같은 처리다)
--
--  ⚠️ 테이블 이름에 unsurveyed 를 넣은 것은 의도다. 여기 담긴 곳은 **접근성을 모른다.**
--     일반 음식점 테이블로 오해해 다른 화면에서 쓰면 무장애 앱의 약속이 조용히 깨진다.
--     쓰는 곳은 recommend.ts 의 식사·카페 슬롯 하나뿐이어야 한다.
--
--  ⚠️ 소스가 비면 손대지 않는다. prod 에는 kor_poi 가 (테이블만 있고) 비어 있어서,
--     무조건 delete + insert 로 짜면 push-data.sh 로 실어 보낸 데이터가 다음 migrate 때
--     지워진다. 018 이 정확히 그 함정이었다 — 파생 테이블의 가드는 **결과가 아니라 원천**을 본다.
--
--  migrate 는 내용 해시로 재적용을 판단하므로 이 파일은 멱등이어야 한다.

create table if not exists unsurveyed_dining (
  content_id      text primary key,
  title           text not null,
  addr1           text,
  firstimage      text,
  mapx            double precision,
  mapy            double precision,
  ldong_regn_cd   text,
  ldong_signgu_cd text
);
create index if not exists idx_ud_region on unsurveyed_dining (ldong_regn_cd, ldong_signgu_cd);

do $$
begin
  if exists (select 1 from kor_poi where service = 'kor' limit 1) then
    delete from unsurveyed_dining;
    insert into unsurveyed_dining
      (content_id, title, addr1, firstimage, mapx, mapy, ldong_regn_cd, ldong_signgu_cd)
    select p.content_id, p.title, p.addr1, p.firstimage, p.mapx, p.mapy,
           p.ldong_regn_cd, p.ldong_signgu_cd
      from kor_poi p
     where p.service = 'kor'
       and p.content_type_id = '39'
       and nullif(p.title, '') is not null
       and nullif(p.firstimage, '') is not null
       -- 무장애에 이미 있는 곳은 barrier_free 갈래에서 나온다. 두 번 담으면 코스에 두 번 뜬다.
       and not exists (select 1 from barrier_free b where b.contentid = p.content_id);
  else
    raise notice '[039] kor_poi 가 비어 있어 건너뜁니다 (기존 unsurveyed_dining 유지)';
  end if;
end $$;
