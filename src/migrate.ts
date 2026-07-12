import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db';

const here = dirname(fileURLToPath(import.meta.url));
const sqlDir = join(here, '..', 'sql');

async function main() {
  const files = (await readdir(sqlDir)).filter((f) => f.endsWith('.sql')).sort();
  if (files.length === 0) {
    console.warn(`[migrate] ${sqlDir} 에 .sql 파일이 없습니다.`);
    return;
  }
  for (const file of files) {
    const sql = await readFile(join(sqlDir, file), 'utf8');
    process.stdout.write(`[migrate] ${file} 적용 중... `);
    await pool.query(sql);
    console.log('done');
  }
  console.log('[migrate] 모든 마이그레이션 완료');
}

main()
  .catch((err) => {
    console.error('[migrate] 실패:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
