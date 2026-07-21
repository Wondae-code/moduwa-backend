// 무장애(접근성) 플랫 테이블 갱신 — kor_poi(korwith) ⨝ kor_with_detail → barrier_free.
// 외부 호출 없는 순수 DB 작업(빠름). API /v1/barrier-free 가 읽는 슬림 사본을 최신화한다.
import { pool, query } from './db';

// 28속성을 배지 4그룹으로 — access_* 플래그(/v1/search 뱃지용) 계산 기준
const ATTR_GROUPS = {
  wheelchair: [
    'parking', 'route', 'publictransport', 'ticketoffice', 'promotion', 'wheelchair', 'exit',
    'elevator', 'restroom', 'auditorium', 'room', 'handicapetc',
  ],
  visual: [
    'braileblock', 'helpdog', 'guidehuman', 'audioguide', 'bigprint', 'brailepromotion',
    'guidesystem', 'blindhandicapetc',
  ],
  hearing: ['signguide', 'videoguide', 'hearingroom', 'hearinghandicapetc'],
  infant: ['stroller', 'lactationroom', 'babysparechair', 'infantsfamilyetc'],
} as const;
const ATTRS = Object.values(ATTR_GROUPS).flat();

async function main() {
  const attrCols = ATTRS.join(', ');
  const attrSel = ATTRS.map((a) => `w.${a}`).join(', ');
  const attrUpd = ATTRS.map((a) => `${a} = excluded.${a}`).join(', ');
  // 그룹 내 속성 중 하나라도 비어있지 않으면 해당 접근성 정보 보유
  const hasAnyExpr = (cols: readonly string[]) => cols.map((a) => `nullif(w.${a},'') is not null`).join(' or ');
  const hasAccessExpr = hasAnyExpr(ATTRS);
  const accessCols = Object.keys(ATTR_GROUPS).map((g) => `access_${g}`).join(', ');
  const accessSel = Object.values(ATTR_GROUPS).map((cols) => `(${hasAnyExpr(cols)})`).join(', ');
  const accessUpd = Object.keys(ATTR_GROUPS).map((g) => `access_${g} = excluded.access_${g}`).join(', ');

  const res = await query(`
    insert into barrier_free (
      contentid, title, contenttypeid, addr1, addr2, mapx, mapy, firstimage, firstimage2,
      area_code, sigungu_code, ldong_regn_cd, ldong_signgu_cd, ${attrCols}, has_image, has_access, ${accessCols})
    select
      p.content_id, p.title, p.content_type_id, p.addr1, p.addr2, p.mapx, p.mapy, p.firstimage, p.firstimage2,
      p.area_code, p.sigungu_code, p.ldong_regn_cd, p.ldong_signgu_cd, ${attrSel},
      (p.firstimage is not null and p.firstimage <> ''),
      (${hasAccessExpr}),
      ${accessSel}
    from kor_poi p join kor_with_detail w on w.content_id = p.content_id
    where p.service = 'korwith'
    on conflict (contentid) do update set
      title = excluded.title, contenttypeid = excluded.contenttypeid,
      addr1 = excluded.addr1, addr2 = excluded.addr2, mapx = excluded.mapx, mapy = excluded.mapy,
      firstimage = excluded.firstimage, firstimage2 = excluded.firstimage2,
      area_code = excluded.area_code, sigungu_code = excluded.sigungu_code,
      ldong_regn_cd = excluded.ldong_regn_cd, ldong_signgu_cd = excluded.ldong_signgu_cd,
      ${attrUpd}, has_image = excluded.has_image, has_access = excluded.has_access, ${accessUpd}, updated_at = now()
  `);
  console.log(`[barrier-free] 갱신 완료 · 영향 행 ${res.rowCount}`);

  const summary = await query<{ n: number; img: number; acc: number; both: number }>(
    `select count(*)::int n, count(*) filter (where has_image)::int img,
            count(*) filter (where has_access)::int acc,
            count(*) filter (where has_image and has_access)::int both from barrier_free`,
  );
  const s = summary.rows[0]!;
  console.log(`[barrier-free] 총 ${s.n}곳 · 이미지 ${s.img} · 접근성정보 ${s.acc} · 이미지+접근성 ${s.both}`);
  await pool.end();
}

main().catch(async (e) => { console.error('[barrier-free] 치명:', e); await pool.end(); process.exitCode = 1; });
