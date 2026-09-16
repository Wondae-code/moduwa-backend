// 혼잡도 집계를 수동으로 다시 만든다. 평소에는 ingest:tats 가 끝에 알아서 부른다 —
//  이 명령은 원본은 그대로인데 집계만 어긋났을 때(예: 036 이 집계하던 시절의 DB) 쓴다.
import { pool } from './db';
import { refreshRegionDaily } from './congestion';

const agg = await refreshRegionDaily();
console.log(agg.skipped
  ? '[congestion] 생략 — tats_cnctr 가 비어 있다(prod 에서는 정상이다)'
  : `[congestion] ${agg.rows}행 · ${agg.from} ~ ${agg.to}`);
await pool.end();
