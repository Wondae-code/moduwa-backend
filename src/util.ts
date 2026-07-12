import type pg from 'pg';

export const ENDPOINT = {
  korService2: 'https://apis.data.go.kr/B551011/KorService2',
  korWithService2: 'https://apis.data.go.kr/B551011/KorWithService2',
  locgoHub: 'https://apis.data.go.kr/B551011/LocgoHubTarService1',
  dataLab: 'https://apis.data.go.kr/B551011/DataLabService',
  tatsCnctr: 'https://apis.data.go.kr/B551011/TatsCnctrRateService',
  areaTarDiv: 'https://apis.data.go.kr/B551011/AreaTarDivService',
  korPetTour: 'https://apis.data.go.kr/B551011/KorPetTourService2',
} as const;

export const str = (v: unknown): string | null =>
  v == null || String(v).trim() === '' ? null : String(v).trim();

export const dbl = (v: unknown): number | null => {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export const intg = (v: unknown): number | null => {
  if (v == null || String(v).trim() === '') return null;
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
};

/** natural_key 기준 멱등 multi-row upsert. Postgres 파라미터 상한(65535) 자동 청크. */
export async function upsertChunked(
  client: pg.PoolClient,
  table: string,
  columns: string[],
  rows: unknown[][],
  conflictCol = 'natural_key',
): Promise<number> {
  if (rows.length === 0) return 0;
  const COL = columns.length;
  const CHUNK = Math.max(1, Math.floor(60000 / COL));
  const updateSet = columns
    .filter((c) => c !== conflictCol)
    .map((c) => `${c} = excluded.${c}`)
    .concat('updated_at = now()')
    .join(', ');

  let total = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values: string[] = [];
    const params: unknown[] = [];
    chunk.forEach((row, r) => {
      const base = r * COL;
      values.push(`(${Array.from({ length: COL }, (_, k) => `$${base + k + 1}`).join(',')})`);
      params.push(...row);
    });
    await client.query(
      `insert into ${table} (${columns.join(',')})
       values ${values.join(',')}
       on conflict (${conflictCol}) do update set ${updateSet}`,
      params,
    );
    total += chunk.length;
  }
  return total;
}
