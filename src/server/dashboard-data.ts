// 대시보드 집계 — 스키마를 introspection 으로 읽어 "지금 이 DB에 있는 것"만 보여준다.
//
// 로컬(전체 수집 원본)과 관리형(API용 슬림 사본)은 테이블 구성이 다르다. 목록을 코드에
// 하드코딩하면 둘 중 하나에서 반드시 깨지므로, pg_class 를 훑어 존재하는 것만 집계한다.
// 새 수집 테이블이 생겨도 대시보드는 자동으로 따라온다.
import type pg from 'pg';
import { config } from '../config';
import { pool } from '../db';

export type TableStat = {
  name: string;
  kind: 'table' | 'view';
  bytes: number;
  estRows: number;
  rows: number | null;        // null = 타임아웃(측정 생략)
  newToday: number | null;    // created_at 이 오늘(KST) 이후 — 순증
  new7d: number | null;
  touchedToday: number | null; // updated_at 이 오늘 이후 — 오늘 API 에서 받아 upsert 한 양
  lastUpdated: string | null;
  timedOut: boolean;
};

const KST_MS = 9 * 3600_000;

/** 한국시간 기준 N일 전 00:00 의 UTC 시각. */
function kstDayStart(daysAgo = 0): Date {
  const d = new Date(Date.now() + KST_MS);
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() - KST_MS - daysAgo * 86400_000);
}

/**
 * 읽기 전용 트랜잭션 + statement_timeout 으로 실행.
 * READ ONLY 는 SQL 콘솔의 마지막 방어선이기도 하다 — 앱 DB 계정에 쓰기 권한이 있어도
 * 이 트랜잭션 안에서는 INSERT/UPDATE/DDL 이 전부 에러가 난다.
 */
export async function readOnlyQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  timeoutMs = config.dashboard.queryTimeoutMs,
): Promise<pg.QueryResult<T>> {
  const client = await pool.connect();
  try {
    await client.query('begin transaction read only');
    await client.query(`set local statement_timeout = ${Math.max(1000, Math.floor(timeoutMs))}`);
    const res = await client.query<T>(sql, params);
    await client.query('rollback');
    return res;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const isTimeout = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === '57014';

// ── 스키마 introspection ─────────────────────────────────────────────────────
type TableMeta = { name: string; kind: 'table' | 'view'; bytes: number; estRows: number; hasCreated: boolean; hasUpdated: boolean };

export async function listTables(): Promise<TableMeta[]> {
  const res = await readOnlyQuery<{
    name: string; kind: string; bytes: number; est_rows: number; has_created: boolean; has_updated: boolean;
  }>(`
    select c.relname                                  as name,
           case when c.relkind = 'v' then 'view' else 'table' end as kind,
           case when c.relkind = 'v' then 0 else pg_total_relation_size(c.oid) end::bigint as bytes,
           greatest(c.reltuples, 0)::bigint           as est_rows,
           bool_or(col.column_name = 'created_at')    as has_created,
           bool_or(col.column_name = 'updated_at')    as has_updated
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join information_schema.columns col
             on col.table_schema = 'public' and col.table_name = c.relname
      where n.nspname = 'public' and c.relkind in ('r', 'm', 'v')
      group by c.relname, c.relkind, c.oid
      order by c.relname`);
  return res.rows.map((r) => ({
    name: r.name,
    kind: r.kind as 'table' | 'view',
    bytes: Number(r.bytes),
    estRows: Number(r.est_rows),
    hasCreated: r.has_created === true,
    hasUpdated: r.has_updated === true,
  }));
}

/** 테이블 1개의 행수 + 오늘/최근 7일 수집량. 타임아웃이면 추정치만 채워 돌려준다. */
async function statOf(t: TableMeta, today: Date, week: Date): Promise<TableStat> {
  const base: TableStat = {
    name: t.name, kind: t.kind, bytes: t.bytes, estRows: t.estRows,
    rows: null, newToday: null, new7d: null, touchedToday: null, lastUpdated: null, timedOut: false,
  };
  const cols = ['count(*)::bigint as rows'];
  if (t.hasCreated) {
    cols.push('count(*) filter (where created_at >= $1)::bigint as new_today');
    cols.push('count(*) filter (where created_at >= $2)::bigint as new_7d');
  }
  if (t.hasUpdated) {
    cols.push('count(*) filter (where updated_at >= $1)::bigint as touched_today');
    cols.push('max(updated_at) as last_updated');
  }
  // 이름은 pg_class 에서 온 실제 식별자이므로 인용만 하면 안전하다.
  const sql = `select ${cols.join(', ')} from public."${t.name}"`;
  // $1=오늘, $2=7일 전. 파라미터 개수는 실제로 참조한 만큼만 넘겨야 한다
  // (updated_at 만 있는 barrier_free 같은 테이블은 $1 하나뿐).
  const params = t.hasCreated ? [today, week] : t.hasUpdated ? [today] : [];
  try {
    const r = await readOnlyQuery<Record<string, unknown>>(sql, params);
    const row = r.rows[0] ?? {};
    const n = (k: string): number | null => (row[k] == null ? null : Number(row[k]));
    return {
      ...base,
      rows: n('rows'),
      newToday: n('new_today'),
      new7d: n('new_7d'),
      touchedToday: n('touched_today'),
      lastUpdated: row['last_updated'] ? new Date(row['last_updated'] as string).toISOString() : null,
    };
  } catch (err) {
    if (isTimeout(err)) return { ...base, timedOut: true };
    throw err;
  }
}

/** 동시 실행 수 제한 — 커넥션 풀(기본 10)을 대시보드가 독점하지 않도록. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = cursor++; i < items.length; i = cursor++) out[i] = await fn(items[i]!);
  });
  await Promise.all(workers);
  return out;
}

// ── 수집 진행률(커버리지) ────────────────────────────────────────────────────
//  "원본 목록 대비 상세를 얼마나 채웠나" — 남은 일수 계산의 근거가 된다.
//  requires 에 적힌 테이블이 이 DB 에 없으면 그 항목은 조용히 건너뛴다.
type CoverageDef = { label: string; note: string; requires: string[]; done: string; total: string };

const COVERAGE: CoverageDef[] = [
  {
    label: '반려동물 상세(detailPetTour2)',
    note: '동반유형·동반가능동물 등 반려동물 전용 항목',
    requires: ['pet_tour_poi', 'pet_tour_detail'],
    done: 'select count(*)::bigint from pet_tour_detail',
    total: 'select count(*)::bigint from pet_tour_poi',
  },
  {
    label: '무장애 상세(detailWithTour2)',
    note: '휠체어·점자블록 등 28개 접근성 속성',
    requires: ['kor_poi', 'kor_with_detail'],
    done: 'select count(*)::bigint from kor_with_detail',
    total: `select count(*)::bigint from kor_poi where service = 'korwith'`,
  },
  {
    label: '관광 상세(detailCommon2)',
    note: '개요·운영시간 — 대상 유형만 수집',
    requires: ['kor_poi', 'kor_detail'],
    done: 'select count(*)::bigint from kor_detail',
    total: `select count(*)::bigint from kor_poi
              where service = 'kor' and content_type_id = any($1)`,
  },
  {
    label: '지역 대표 관광지 상세',
    note: 'TourAPI 개요 → 카카오 → 지도링크 3단 폴백',
    requires: ['locgo_hub_records', 'locgo_hub_detail'],
    done: 'select count(*)::bigint from locgo_hub_detail',
    total: 'select count(distinct hub_tats_cd)::bigint from locgo_hub_records',
  },
  {
    label: '카카오 매칭 성공률',
    note: '이름+좌표 fuzzy 매칭이 실제로 붙은 비율',
    requires: ['kakao_place'],
    done: 'select count(*)::bigint from kakao_place where matched',
    total: 'select count(*)::bigint from kakao_place',
  },
  {
    label: '무장애 슬림 테이블(barrier_free)',
    note: 'API 가 읽는 사본 — 원본 POI 대비',
    requires: ['kor_poi', 'barrier_free'],
    done: 'select count(*)::bigint from barrier_free',
    total: `select count(*)::bigint from kor_poi where service = 'korwith'`,
  },
];

export type Coverage = { label: string; note: string; done: number; total: number; pct: number };

async function coverage(present: Set<string>): Promise<Coverage[]> {
  const defs = COVERAGE.filter((d) => d.requires.every((t) => present.has(t)));
  const out = await mapLimited(defs, 3, async (d) => {
    const params = d.total.includes('$1') ? [config.kordetailTypes] : [];
    try {
      const [done, total] = await Promise.all([
        readOnlyQuery<{ count: number }>(d.done),
        readOnlyQuery<{ count: number }>(d.total, params),
      ]);
      const dn = Number(done.rows[0]?.['count'] ?? 0);
      const tn = Number(total.rows[0]?.['count'] ?? 0);
      return { label: d.label, note: d.note, done: dn, total: tn, pct: tn > 0 ? (dn / tn) * 100 : 0 };
    } catch (err) {
      if (isTimeout(err)) return null;
      throw err;
    }
  });
  return out.filter((c): c is Coverage => c !== null);
}

// ── 작업큐 · 실행 로그 ───────────────────────────────────────────────────────
export type QueueRow = { queue: string; status: string; n: number };

async function queues(present: Set<string>): Promise<QueueRow[]> {
  const parts: string[] = [];
  if (present.has('tar_rlte_tasks')) parts.push(`select '연관관광지' as queue, status, count(*)::int as n from tar_rlte_tasks group by status`);
  if (present.has('locgo_hub_tasks')) parts.push(`select '기초지자체중심', status, count(*)::int from locgo_hub_tasks group by status`);
  if (parts.length === 0) return [];
  const res = await readOnlyQuery<QueueRow>(`${parts.join(' union all ')} order by 1, 2`);
  return res.rows.map((r) => ({ ...r, n: Number(r.n) }));
}

async function runs(present: Set<string>): Promise<Record<string, unknown>[]> {
  if (!present.has('ingest_runs')) return [];
  const res = await readOnlyQuery(`
    select id, requests_made, tasks_done, records_upserted, stopped_reason,
           to_char(started_at at time zone 'Asia/Seoul', 'MM-DD HH24:MI')  as started,
           to_char(finished_at at time zone 'Asia/Seoul', 'MM-DD HH24:MI') as finished
      from ingest_runs order by id desc limit 10`);
  return res.rows;
}

// ── 개요 ─────────────────────────────────────────────────────────────────────
export type Overview = {
  generatedAt: string;
  kstDate: string;
  database: string;
  dbBytes: number;
  tables: TableStat[];
  totals: { rows: number; newToday: number; new7d: number; touchedToday: number; bytes: number; partial: boolean };
  coverage: Coverage[];
  queues: QueueRow[];
  runs: Record<string, unknown>[];
};

export async function overview(): Promise<Overview> {
  const today = kstDayStart(0);
  const week = kstDayStart(7);
  const metas = await listTables();
  const present = new Set(metas.map((m) => m.name));

  const [stats, cov, q, r, dbInfo] = await Promise.all([
    mapLimited(metas, 4, (m) => statOf(m, today, week)),
    coverage(present),
    queues(present),
    runs(present),
    readOnlyQuery<{ name: string; bytes: number }>(
      'select current_database() as name, pg_database_size(current_database())::bigint as bytes',
    ),
  ]);

  const sum = (pick: (s: TableStat) => number | null): number =>
    stats.reduce((acc, s) => acc + (s.kind === 'view' ? 0 : pick(s) ?? 0), 0);

  return {
    generatedAt: new Date().toISOString(),
    kstDate: new Date(Date.now() + KST_MS).toISOString().slice(0, 10),
    database: dbInfo.rows[0]?.name ?? '',
    dbBytes: Number(dbInfo.rows[0]?.bytes ?? 0),
    tables: stats,
    totals: {
      rows: sum((s) => s.rows),
      newToday: sum((s) => s.newToday),
      new7d: sum((s) => s.new7d),
      touchedToday: sum((s) => s.touchedToday),
      bytes: sum((s) => s.bytes),
      // 하나라도 타임아웃 났으면 합계가 과소집계임을 UI 에 알린다.
      partial: stats.some((s) => s.timedOut),
    },
    coverage: cov,
    queues: q,
    runs: r,
  };
}

// ── 테이블 브라우저 ──────────────────────────────────────────────────────────
export async function browse(
  table: string,
  limit: number,
  offset: number,
): Promise<{ columns: string[]; rows: unknown[][] }> {
  const metas = await listTables();
  // 화이트리스트 대조 — 여기서 걸러야 아래 문자열 결합이 안전해진다.
  if (!metas.some((m) => m.name === table)) throw new Error(`알 수 없는 테이블: ${table}`);
  const res = await readOnlyQuery(
    `select * from public."${table}" order by 1 limit ${limit} offset ${offset}`,
  );
  return {
    columns: res.fields.map((f) => f.name),
    rows: res.rows.map((row) => res.fields.map((f) => (row as Record<string, unknown>)[f.name])),
  };
}

// ── SQL 콘솔 ─────────────────────────────────────────────────────────────────
export type QueryResult = { columns: string[]; rows: unknown[][]; rowCount: number; ms: number; truncated: boolean };

export async function runConsoleQuery(input: string): Promise<QueryResult> {
  const sql = input.trim().replace(/;\s*$/, '').trim();
  if (!sql) throw new Error('쿼리가 비어 있습니다.');
  if (!/^(select|with)\b/i.test(sql)) {
    throw new Error('select 또는 with 로 시작하는 조회만 실행할 수 있습니다.');
  }
  if (sql.includes(';')) {
    // 문자열 리터럴 안의 세미콜론까지 막히지만, 여러 문 실행을 확실히 차단하는 쪽을 택한다.
    throw new Error('세미콜론은 쓸 수 없습니다 — 한 번에 한 문장만 실행합니다.');
  }

  const cap = config.dashboard.queryRowLimit;
  const started = Date.now();
  // cap+1 을 받아 "잘렸는지"를 판별한다.
  const res = await readOnlyQuery(`select * from (${sql}) as _q limit ${cap + 1}`);
  const truncated = res.rows.length > cap;
  const rows = truncated ? res.rows.slice(0, cap) : res.rows;
  return {
    columns: res.fields.map((f) => f.name),
    rows: rows.map((row) => res.fields.map((f) => (row as Record<string, unknown>)[f.name])),
    rowCount: rows.length,
    ms: Date.now() - started,
    truncated,
  };
}
