import { pool, query } from './db';

async function main() {
  const overview = await query(
    `select '연관관광지(TarRlte)' as 데이터셋, count(*)::bigint as 레코드 from tar_rlte_records
     union all select '기초지자체중심(LocgoHub)', count(*) from locgo_hub_records
     union all select 'POI(KorService2/무장애)', count(*) from kor_poi
     union all select '집중률예측(TatsCnctr)', count(*) from tats_cnctr
     union all select '방문자수(DataLab)', count(*) from datalab_visitor
     order by 레코드 desc`,
  );
  console.log('── 데이터셋별 적재 레코드 ──');
  console.table(overview.rows);

  const queues = await query(
    `select '연관관광지' as 큐, status as 상태, count(*)::int as n from tar_rlte_tasks group by status
     union all select '기초지자체중심', status, count(*)::int from locgo_hub_tasks group by status
     order by 큐, 상태`,
  );
  console.log('── 다일(多日) 작업큐 현황 ──');
  console.table(queues.rows);

  const poi = await query(
    `select service as 서비스, count(*)::int as 건수 from kor_poi group by service order by service`,
  );
  console.log('── POI 서비스별 ──');
  console.table(poi.rows);

  const runs = await query(
    `select id, requests_made as 요청, tasks_done as 작업, records_upserted as 레코드,
            stopped_reason as 종료사유, to_char(started_at AT TIME ZONE 'Asia/Seoul','MM-DD HH24:MI') as 시작
       from ingest_runs order by id desc limit 5`,
  );
  console.log('── 연관관광지 실행 로그 ──');
  console.table(runs.rows);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => pool.end());
