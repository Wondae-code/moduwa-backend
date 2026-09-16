// 지역·날짜별 혼잡도 집계 — 추천이 요청 시점에 읽는 tats_region_daily 를 다시 만든다.
//
//  추천(recommend.ts)은 tats_cnctr(66만 행·440MB)를 직접 훑지 않고 이 집계 테이블만 읽는다.
//  그래서 **원본이 갱신되면 집계도 함께 갱신되어야 한다.**
//
// ⚠️ **예전에는 이 집계가 마이그레이션 036 안에만 있었다.** 마이그레이션은 파일 해시가 바뀔
//    때만 다시 도니 사실상 한 번 돌고 끝이었고, ingest:tats 가 매일 원본을 늘려도 집계는
//    처음 값에 멈춰 있었다. 2026-09-16 확인: 원본은 20261015 까지 있는데 집계는 20260913 에서
//    멈춰, **사용자가 고르는 미래 날짜가 전부 "데이터 없음"** 이 되어 있었다. 그래서 집계를
//    036 에서 떼어 여기로 옮기고, 원본을 채우는 ingest-tats 가 끝에 이것을 부르게 했다 —
//    원본과 집계가 같은 명령에서 함께 움직이면 다시 어긋날 자리가 없다.
//
// ⚠️ **소스가 비어 있으면 손대지 않는다.** prod 에는 tats_cnctr 가 (테이블은 있고) 비어 있다.
//    무조건 delete 로 짜면 push-data.sh 로 실어 보낸 집계가 prod 에서 지워진다.
import { query, withTransaction } from './db';

export type CongestionAgg = { rows: number; from: string | null; to: string | null; skipped: boolean };

export async function refreshRegionDaily(): Promise<CongestionAgg> {
  const hasSource = ((await query('select 1 from tats_cnctr limit 1')).rowCount ?? 0) > 0;
  if (!hasSource) return { rows: 0, from: null, to: null, skipped: true };

  // 한 트랜잭션 안에서 지우고 다시 넣는다 — 커밋 전까지 읽는 쪽은 이전 값을 보므로
  //  집계 도중에 추천이 "혼잡도 없음" 을 보는 구간이 생기지 않는다.
  await withTransaction(async (c) => {
    await c.query('delete from tats_region_daily');
    await c.query(
      `insert into tats_region_daily (regn_cd, base_ymd, rate)
       select left(signgu_cd, 2), base_ymd, avg(cnctr_rate)::numeric(6,2)
         from tats_cnctr
        where signgu_cd is not null and base_ymd is not null
        group by 1, 2`);
  });

  const r = (await query<{ n: number; frm: string | null; too: string | null }>(
    'select count(*)::int n, min(base_ymd) frm, max(base_ymd) too from tats_region_daily')).rows[0]!;
  return { rows: r.n, from: r.frm, to: r.too, skipped: false };
}
