// 무장애(접근성) 플랫 테이블 갱신 — kor_poi(korwith) ⨝ kor_with_detail → barrier_free.
// 외부 호출 없는 순수 DB 작업(빠름). API /v1/barrier-free 가 읽는 슬림 사본을 최신화한다.
//
// 신분류체계 코드(lcls_systm1/2/3)도 함께 옮긴다 — 추천 엔진이 숙박을 호텔·모텔·펜션으로
// 가르는 근거다(032 주석에 실측 분포). contenttypeid 만으로는 '숙박' 까지밖에 모른다.
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

// 고령자(관광공사 5번째 유형)는 위 네 그룹처럼 전용 속성 묶음이 없다 —
//  공식 항목이 "휠체어 대여 · 이동보조기기 대여" 뿐이고, 그 둘만으로는 14.5% 에 그친다.
//  대부분의 고령 여행자는 휠체어를 쓰지 않고 실제로 겪는 문제는 계단과 걷는 거리라서
//  승강기·주차를 함께 본다(037 주석에 근거). 다른 그룹과 달리 속성이 겹치므로 식을 따로 쓴다.
//  ⚠️ coalesce 가 필요하다 — handicapetc 가 null 이면 정규식 결과가 false 가 아니라 null 이고,
//     `false or null` 도 null 이라 not null 컬럼에 넣다가 실패한다.
const ELDERLY_EXPR = `(
     nullif(w.wheelchair, '') is not null
  or coalesce(w.handicapetc ~ '이동보조|전동스쿠터|스쿠터|보행보조', false)
  or nullif(w.elevator, '') is not null
  or nullif(w.parking, '') is not null)`;

async function main() {
  const attrCols = ATTRS.join(', ');
  const attrSel = ATTRS.map((a) => `w.${a}`).join(', ');
  const attrUpd = ATTRS.map((a) => `${a} = excluded.${a}`).join(', ');
  // 그룹 내 속성 중 하나라도 비어있지 않으면 해당 접근성 정보 보유
  const hasAnyExpr = (cols: readonly string[]) => cols.map((a) => `nullif(w.${a},'') is not null`).join(' or ');
  const hasAccessExpr = hasAnyExpr(ATTRS);
  const accessCols = [...Object.keys(ATTR_GROUPS).map((g) => `access_${g}`), 'access_elderly'].join(', ');
  const accessSel = [...Object.values(ATTR_GROUPS).map((cols) => `(${hasAnyExpr(cols)})`), ELDERLY_EXPR].join(', ');
  const accessUpd = [...Object.keys(ATTR_GROUPS), 'elderly']
    .map((g) => `access_${g} = excluded.access_${g}`).join(', ');

  const res = await query(`
    insert into barrier_free (
      contentid, title, contenttypeid, addr1, addr2, mapx, mapy, firstimage, firstimage2,
      area_code, sigungu_code, ldong_regn_cd, ldong_signgu_cd,
      lcls_systm1, lcls_systm2, lcls_systm3, ${attrCols}, has_image, has_access, ${accessCols})
    select
      p.content_id, p.title, p.content_type_id, p.addr1, p.addr2, p.mapx, p.mapy, p.firstimage, p.firstimage2,
      p.area_code, p.sigungu_code, p.ldong_regn_cd, p.ldong_signgu_cd,
      p.lcls_systm1, p.lcls_systm2, p.lcls_systm3, ${attrSel},
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
      lcls_systm1 = excluded.lcls_systm1, lcls_systm2 = excluded.lcls_systm2,
      lcls_systm3 = excluded.lcls_systm3,
      ${attrUpd}, has_image = excluded.has_image, has_access = excluded.has_access, ${accessUpd}, updated_at = now()
  `);
  console.log(`[barrier-free] 갱신 완료 · 영향 행 ${res.rowCount}`);

  const summary = await query<{ n: number; img: number; acc: number; both: number; lcls: number; stay: number }>(
    `select count(*)::int n, count(*) filter (where has_image)::int img,
            count(*) filter (where has_access)::int acc,
            count(*) filter (where has_image and has_access)::int both,
            count(*) filter (where nullif(lcls_systm3,'') is not null)::int lcls,
            count(*) filter (where contenttypeid = '32'
                               and nullif(lcls_systm3,'') is not null)::int stay
       from barrier_free`,
  );
  const s = summary.rows[0]!;
  console.log(`[barrier-free] 총 ${s.n}곳 · 이미지 ${s.img} · 접근성정보 ${s.acc} · 이미지+접근성 ${s.both}`);
  const g = (await query<Record<string, number>>(
    `select count(*) filter (where access_wheelchair)::int w, count(*) filter (where access_visual)::int v,
            count(*) filter (where access_hearing)::int h,   count(*) filter (where access_infant)::int i,
            count(*) filter (where access_elderly)::int e from barrier_free`,
  )).rows[0]!;
  console.log(`[barrier-free] 유형별 · 지체 ${g.w} · 시각 ${g.v} · 청각 ${g.h} · 영유아 ${g.i} · 고령자 ${g.e}`);
  // 분류코드가 비면 추천의 가격대 배지가 통째로 죽는다. 조용히 비지 않게 매번 찍는다.
  console.log(`[barrier-free] 분류코드 ${s.lcls}/${s.n} · 숙박 분류 ${s.stay}곳`);
  await pool.end();
}

main().catch(async (e) => { console.error('[barrier-free] 치명:', e); await pool.end(); process.exitCode = 1; });
