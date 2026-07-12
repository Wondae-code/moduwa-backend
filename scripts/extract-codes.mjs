// TourAPI 시군구 코드표(xlsx) → src/sigungu-codes.json
// 사용: node scripts/extract-codes.mjs <xlsx경로>
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const xlsx = process.argv[2];
if (!xlsx) {
  console.error('사용법: node scripts/extract-codes.mjs <xlsx경로>');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'xlsx-'));
execSync(
  `unzip -oq "${xlsx}" xl/sharedStrings.xml xl/worksheets/sheet1.xml -d "${dir}"`,
);

const ss = readFileSync(join(dir, 'xl/sharedStrings.xml'), 'utf8');
const strings = [...ss.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
  [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''),
);

const sheet = readFileSync(join(dir, 'xl/worksheets/sheet1.xml'), 'utf8');
const rows = [...sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((r) => {
  const cells = {};
  // 셀 속성(r, s, t)은 순서가 제각각 → 여는 태그 전체를 잡고 개별 파싱
  for (const c of r[1].matchAll(/<c\s+([^>]*?)>\s*<v>([\s\S]*?)<\/v>/g)) {
    const [, attrs, raw] = c;
    const col = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
    if (!col) continue;
    const isStr = /\bt="s"/.test(attrs);
    cells[col] = isStr ? strings[Number(raw)] : raw;
  }
  return cells;
});

// 1행은 헤더 → 제외. A=areaCd, B=areaNm, C=signguCd, D=signguNm
const data = rows
  .slice(1)
  .filter((r) => r.A && r.C)
  .map((r) => ({
    areaCd: String(r.A),
    areaNm: String(r.B ?? ''),
    signguCd: String(r.C),
    signguNm: String(r.D ?? ''),
  }));

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'src', 'sigungu-codes.json');
writeFileSync(out, JSON.stringify(data, null, 2) + '\n');
console.log(`헤더: ${strings.slice(246, 250).join(' | ')}`);
console.log(`시군구 ${data.length}개 → ${out}`);
console.log('시도별 개수:');
const byArea = {};
for (const d of data) byArea[d.areaNm] = (byArea[d.areaNm] ?? 0) + 1;
console.log(byArea);
