import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { TarRlteItem } from './client';

// tar_rlte_records 컬럼 순서 (raw, natural_key 제외한 매핑 대상)
const FIELD_MAP: Array<[col: string, key: string]> = [
  ['base_ym', 'baseYm'],
  ['t_ats_cd', 'tAtsCd'],
  ['t_ats_nm', 'tAtsNm'],
  ['area_cd', 'areaCd'],
  ['area_nm', 'areaNm'],
  ['signgu_cd', 'signguCd'],
  ['signgu_nm', 'signguNm'],
  ['rlte_tats_cd', 'rlteTatsCd'],
  ['rlte_tats_nm', 'rlteTatsNm'],
  ['rlte_regn_cd', 'rlteRegnCd'],
  ['rlte_regn_nm', 'rlteRegnNm'],
  ['rlte_signgu_cd', 'rlteSignguCd'],
  ['rlte_signgu_nm', 'rlteSignguNm'],
  ['rlte_ctgry_lcls_nm', 'rlteCtgryLclsNm'],
  ['rlte_ctgry_mcls_nm', 'rlteCtgryMclsNm'],
  ['rlte_ctgry_scls_nm', 'rlteCtgrySclsNm'],
];

const COLUMNS = [...FIELD_MAP.map(([c]) => c), 'rlte_rank', 'raw', 'natural_key'];
const COL_COUNT = COLUMNS.length; // 19

const str = (v: unknown): string | null =>
  v == null || String(v).trim() === '' ? null : String(v);

const int = (v: unknown): number | null => {
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
};

export function naturalKey(item: TarRlteItem): string {
  const tats = str(item['tAtsCd']);
  const rlte = str(item['rlteTatsCd']);
  if (tats && rlte) {
    return `${str(item['baseYm']) ?? ''}:${str(item['signguCd']) ?? ''}:${tats}:${rlte}`;
  }
  // 필수키 누락 시 전체 해시로 폴백(중복 방지)
  return createHash('sha1').update(JSON.stringify(item)).digest('hex');
}

function toRow(item: TarRlteItem): unknown[] {
  const row: unknown[] = FIELD_MAP.map(([, key]) => str(item[key]));
  row.push(int(item['rlteRank'])); // rlte_rank
  row.push(JSON.stringify(item)); // raw
  row.push(naturalKey(item)); // natural_key
  return row;
}

const updateSet = COLUMNS.filter((c) => c !== 'natural_key')
  .map((c) => `${c} = excluded.${c}`)
  .concat('updated_at = now()')
  .join(', ');

// Postgres 파라미터 상한(65535) 회피용 청크 크기
const CHUNK = Math.floor(60000 / COL_COUNT); // ≈ 3157

/** item들을 natural_key 기준 멱등 upsert. 반환: 처리한 행 수. */
export async function upsertRecords(
  client: pg.PoolClient,
  items: TarRlteItem[],
): Promise<number> {
  let total = 0;
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK);
    const values: string[] = [];
    const params: unknown[] = [];
    chunk.forEach((item, r) => {
      const base = r * COL_COUNT;
      values.push(`(${Array.from({ length: COL_COUNT }, (_, k) => `$${base + k + 1}`).join(',')})`);
      params.push(...toRow(item));
    });
    await client.query(
      `insert into tar_rlte_records (${COLUMNS.join(',')})
       values ${values.join(',')}
       on conflict (natural_key) do update set ${updateSet}`,
      params,
    );
    total += chunk.length;
  }
  return total;
}
