// AI 추천 코스 — 기획팀 명세("모두와 — AI 추천 코스 로직 명세서") v1 구현.
//
// ── 이 파일이 지키는 원칙 두 가지
//
//  ① **모르는 것에 벌점을 주지 않는다.**
//     hub_rank(인기순위)와 혼잡도는 실측 커버리지가 24% 다(033 주석). 이름+시군구로만 우리
//     장소와 이어지는데 전국 "기준 관광지" 가 6,574곳뿐이라, 음식점·쇼핑·숙박은 애초에
//     대상이 아니다. 이 신호를 필수로 쓰면 후보의 4분의 3이 사라진다.
//     그래서 **없으면 0점(중립)** 이고, 있는 경우에만 가산한다. 명세 4번이 정한
//     "detailPetTour2 미등록 ≠ 노펫존" 과 같은 논리다.
//
//  ② **점수는 코드에 없다.** 전부 recommend_weights 에서 읽는다(명세 5번 요청).
//     기획팀이 배포 없이 조정하고, 명세 5-3 의 지표를 보며 튜닝한다.
//
// ── v1 이 하지 않는 것 (의도적)
//  · 카카오 Directions — 후보 조합마다 부르면 쿼터가 즉시 바닥난다. v1 은 직선거리로
//    하루 안의 순서를 잡고, 실제 경로 안내는 확정된 일정에만 붙인다(v2).
//  · 시간대별 배치 — 혼잡도가 **일 단위** 데이터라 애초에 불가능하다(명세도 같은 판단).
//  · 노키즈존·노펫존 제외 — 공식 데이터가 없다. v1 은 양성 신호를 위로 올리는 것으로 갈음한다.
//    "가면 입장을 거절당하는" 경우는 이 방식으로 막지 못한다 — 의식적으로 미룬 것이다.
import { query } from '../db';

// ── 동반자 유형. 명세 2-2 의 태그 소스이자 가중치 분기다.
export type PartyKind = 'kids' | 'pet' | 'elderly' | 'couple' | 'friends' | 'solo';
const PARTY_KINDS = new Set<PartyKind>(['kids', 'pet', 'elderly', 'couple', 'friends', 'solo']);

/** 하루 템플릿 — 명세 3번: 아침 · 컨텐츠 · 점심 · 컨텐츠 2 + 카페 1 · 저녁 · 컨텐츠 */
const DAY_TEMPLATE = [
  'meal_morning', 'spot', 'meal_lunch', 'spot', 'spot', 'cafe', 'meal_dinner', 'spot',
] as const;
type Slot = (typeof DAY_TEMPLATE)[number];

// TourAPI contenttypeid — 12 관광지 / 14 문화시설 / 15 축제 / 28 레포츠 / 32 숙박 / 38 쇼핑 / 39 음식
const SPOT_TYPES = ['12', '14', '15', '28'];
const FOOD_TYPE = '39';
const STAY_TYPE = '32';

/** 앱 카드에 그대로 쓰는 표시 라벨. 유형 코드를 그대로 내보내면 앱이 매핑표를 또 갖게 된다. */
const TYPE_LABEL: Record<string, string> = {
  '12': '관광지', '14': '문화시설', '15': '축제·공연', '28': '레포츠',
  '32': '숙박', '38': '쇼핑', '39': '음식점',
};

// ── 식사 시간대. 카카오 세부 분류로 가른다.
//  ⚠️ **거르지 않고 점수만 조정한다.** 후보가 적은 지역(가평 28곳)에서 거르면 칸이 통째로
//     비는데, 어울리지 않는 식당이라도 있는 편이 빈 칸보다 낫다.
const MORNING_WORDS = ['해장국', '국밥', '곰탕', '설렁탕', '죽', '순대', '두부', '국수',
  '감자탕', '베이커리', '제과', '간식', '분식', '샐러드', '샌드위치', '토스트', '패스트푸드'];
const EVENING_WORDS = ['육류', '고기', '해물', '생선', '술집', '치킨', '호프', '이자카야',
  '곱창', '막창', '전골', '사철탕', '영양탕', '횟집', '회'];

function mealTime(cat: string | null): 'morning' | 'evening' | 'any' {
  if (!cat) return 'any';
  if (MORNING_WORDS.some((wd) => cat.includes(wd))) return 'morning';
  if (EVENING_WORDS.some((wd) => cat.includes(wd))) return 'evening';
  return 'any';
}

/** 테마 → 장소 유형. 고른 테마와 유형이 맞으면 theme.match 가산. */
const THEME_TYPES: Record<string, string[]> = {
  camping: ['28'], waterpark: ['28'], photo: ['12', '14'], nature: ['12'],
  indoor: ['14', '38'], heritage: ['12', '14'], scenery: ['12'], shopping: ['38'],
  culture: ['14'], art: ['14'], food: ['39'], nightview: ['12'],
};

// ── 숙박 가격대 → 신분류체계 코드 (명세 2-1). 실측 분포는 032 주석 참고.
//  ⚠️ 접두어로 짜면 안 된다 — 리조트(VE050200)가 AC 가 아니라 VE05(휴양) 아래다.
//     'AC' 로 좁히면 리조트 64곳이 통째로 빠진다.
//  ⚠️ 청소년수련원(VE100200)은 명세가 매핑 제외로 지정했다(실제로 2곳뿐).
const BUDGET_CODES: Record<string, string[]> = {
  low:    ['AC040100', 'AC030300', 'AC030400', 'AC060100', 'AC060200'], // 모텔·민박·게스트하우스·유스호스텔
  medium: ['AC030100', 'AC030200', 'AC010100'],                        // 펜션·한옥·호텔
  high:   ['AC020100', 'AC020200', 'VE050200'],                        // 콘도·레지던스·리조트
};
const EXCLUDED_STAY = ['VE100200'];
/** 폴백 순서 — 명세 2-1: 가성비 없음→적당히 / 적당히 없음→양쪽 / 여유롭게 없음→적당히 */
const BUDGET_FALLBACK: Record<string, string[]> = {
  low: ['medium'], medium: ['low', 'high'], high: ['medium'],
};

// ── 가중치 캐시. 배포 없이 바꾸는 게 목적이므로 오래 들고 있으면 안 되고,
//    요청마다 읽으면 추천 한 번에 쿼리가 하나 더 붙는다. 60초가 타협점이다.
let weightCache: { at: number; map: Map<string, number> } | null = null;
const WEIGHT_TTL_MS = 60_000;

async function weights(): Promise<Map<string, number>> {
  if (weightCache && Date.now() - weightCache.at < WEIGHT_TTL_MS) return weightCache.map;
  const rows = (await query<{ key: string; value: string }>(
    'select key, value from recommend_weights',
  )).rows;
  const map = new Map(rows.map((r) => [r.key, Number(r.value)]));
  weightCache = { at: Date.now(), map };
  return map;
}

export type RecommendInput = {
  region?: string;                 // 슬러그. regionCode 와 둘 중 하나는 필요
  regionCode?: string;             // ldong_regn_cd
  sigunguCode?: string;            // ldong_signgu_cd
  startDate: string;               // YYYY-MM-DD
  endDate: string;
  party?: PartyKind[];
  themes?: string[];
  budget?: 'low' | 'medium' | 'high';
  dayTripOnly?: boolean;
};

export type RecommendNote =
  | 'budget_fallback'              // 고른 가격대에 후보가 없어 확장했다
  | 'budget_ignored'               // 그래도 없어 가격대 없이 전체 숙박을 노출했다
  | 'no_congestion_data'           // 여행일이 혼잡도 예측 범위 밖이다
  | 'thin_pool'                    // 후보가 적어 일부 슬롯을 채우지 못했다
  | 'includes_unsurveyed'          // 무장애 조사를 받지 않은 식당·카페가 섞였다(hasAccessInfo=false)
  | 'empty_pool';                  // 이 지역에 쓸 후보가 사실상 없다 — 빈 코스를 내보내지 않는다

type Candidate = {
  contentid: string; title: string; contenttypeid: string;
  addr1: string | null; firstimage: string | null;
  mapx: number | null; mapy: number | null;
  hub_rank: number | null; tats_nm: string | null;
  access_infant: boolean; access_wheelchair: boolean; access_elderly: boolean; has_image: boolean;
  lcls_systm3: string | null;
  is_pet_ok: boolean; is_cafe: boolean; kakao_cat: string | null; norm_name: string;
  /**
   * 무장애 조사를 받은 곳인가. false 면 접근성을 **모르는** 것이지 나쁘다는 뜻이 아니다.
   * 식사·카페 슬롯에만 false 가 섞인다(아래 collectCandidates 주석).
   */
  has_access_info: boolean;
  /** 인기순위 가산점. **관광 슬롯에서만** 더한다 — 아래 주석 참고. */
  hub_bonus: number;
  tag_hits: number; restdate: string | null;
  score: number;
};

/** 지역 슬러그·코드를 (regn, signgu) 로 푼다. 알 수 없으면 null — 조용히 전국을 뒤지지 않는다. */
export async function resolveRegion(
  input: RecommendInput,
): Promise<{ regn: string; signgu: string | null; label: string } | null> {
  if (input.regionCode) {
    return { regn: input.regionCode, signgu: input.sigunguCode ?? null, label: input.regionCode };
  }
  if (!input.region) return null;
  const row = (await query<{ regn_cd: string; signgu_cd: string | null; label: string }>(
    'select regn_cd, signgu_cd, label from region_slugs where slug = $1', [input.region.trim()],
  )).rows[0];
  return row ? { regn: row.regn_cd, signgu: row.signgu_cd, label: row.label } : null;
}

/**
 * 후보를 모으고 점수를 매긴다.
 *
 * 후기 태그(명세 2-2 의 2순위 신호)는 **행동이 있는 후기**만 센다 — 추천 노출만으로 점수가
 * 오르면 노출→가점→재노출의 순환이 생긴다(명세가 명시적으로 경계한 것).
 * 후기는 실제로 다녀와야 쓸 수 있으므로 그 자체가 행동 증거다.
 */
async function collectCandidates(
  region: { regn: string; signgu: string | null },
  party: PartyKind[],
  themes: string[],
  w: Map<string, number>,
): Promise<Candidate[]> {
  const wantTypes = new Set<string>([...SPOT_TYPES, FOOD_TYPE, STAY_TYPE, '38']);
  const themeTypes = new Set(themes.flatMap((t) => THEME_TYPES[t] ?? []));
  // 동반자별 후기 태그 코드(review_tag_defs 와 같은 어휘)
  const tagCodes = party.flatMap((p) =>
    p === 'kids' ? ['kids'] : p === 'pet' ? ['pet'] : p === 'elderly' ? ['silver'] : []);

  const rows = (await query<Candidate>(`
    select b.contentid, b.title, b.contenttypeid, b.addr1, b.firstimage,
           b.mapx, b.mapy, b.hub_rank, b.tats_nm,
           b.access_infant, b.access_wheelchair, b.access_elderly, b.has_image, b.lcls_systm3,
           exists (select 1 from pet_tour_poi p where p.contentid = b.contentid) as is_pet_ok,
           -- 카페 슬롯은 카카오 분류(CE7)로 고른다. 관광공사 유형에는 '카페' 가 없어서
           --  음식(39)에서 아무거나 고르면 순두부집이 카페 자리에 들어간다(실제로 그랬다).
           exists (select 1 from kakao_place k
                    where k.content_id = b.contentid and k.matched
                      and k.category_group_code = 'CE7') as is_cafe,
           -- 식사 시간대 판단용 세부 분류('음식점 > 한식 > 해장국'). 관광공사 유형에는
           --  이 정보가 없어 아침 자리에 횟집이 들어갔다(실제로 그랬다).
           (select k.category_name from kakao_place k
             where k.content_id = b.contentid and k.matched limit 1) as kakao_cat,
           coalesce((select count(*) from review_tags rt
                       join reviews r on r.id = rt.review_id
                      where r.content_id = b.contentid and rt.tag_code = any($4)), 0)::int as tag_hits,
           (select k.intro_raw->>'restdate' from kor_detail k where k.content_id = b.contentid) as restdate,
           -- 018 과 같은 정규화. barrier_free 에는 같은 이름의 다른 contentid 가 있다
           --  (예: '롯데백화점 본점' 132668 · 2902442). 그대로 두면 한 코스에 같은 곳이 두 번 나온다.
           regexp_replace(lower(b.title), '[^0-9a-z가-힣]', '', 'g') as norm_name,
           true as has_access_info,
           0::numeric as score, 0::numeric as hub_bonus
      from barrier_free b
     where b.ldong_regn_cd = $1
       and ($2::text is null or b.ldong_signgu_cd = $2)
       and b.contenttypeid = any($3)
       and b.has_image                       -- 카드에 쓸 사진이 없으면 추천 화면이 비어 보인다

    union all

    -- ── 무장애 조사를 받지 **않은** 음식점. 식사·카페 자리에만 쓴다.
    --  왜 필요한가: 병목은 볼거리가 아니라 먹는 자리다. 가평은 볼거리가 20곳인데
    --  무장애 등록 식당이 **1곳**이라 2박 일정의 아홉 끼를 채울 수 없었다(실측).
    --  넓히면 78곳이 된다. 새로 수집할 것은 없다 — 이미 갖고 있던 데이터다.
    --  원천은 kor_poi(187MB)인데 추천이 쓰는 것은 9천여 행뿐이라 039 가 추려 굳혀 둔다.
    --  그래야 관리형 DB 로 실어 보낼 수 있다(push-data.sh).
    --
    --  ⚠️ 볼거리·숙소는 넓히지 않는다. 그쪽은 부족하지 않고, 접근성을 모르는 곳을
    --     코스 전반에 섞으면 무장애 앱의 약속이 무너진다. 확장은 최소 범위로 묶는다.
    --  ⚠️ has_access_info=false 로 표시해 응답까지 그대로 흘려보낸다. 조용히 섞으면
    --     사용자가 조사된 곳으로 오해한다.
    --  hub_rank·혼잡도·무장애 플래그는 이쪽에 없다 — 전부 중립값이고, 그래도 되는 이유는
    --  "모르는 것에 벌점을 주지 않는다"는 이 파일의 원칙 그대로다.
    select p.content_id as contentid, p.title, '39' as contenttypeid,
           p.addr1, p.firstimage,
           p.mapx, p.mapy, null::integer as hub_rank, null::text as tats_nm,
           false as access_infant, false as access_wheelchair, false as access_elderly,
           true as has_image, null::text as lcls_systm3,
           false as is_pet_ok,
           exists (select 1 from kakao_place k
                    where k.content_id = p.content_id and k.matched
                      and k.category_group_code = 'CE7') as is_cafe,
           (select k.category_name from kakao_place k
             where k.content_id = p.content_id and k.matched limit 1) as kakao_cat,
           coalesce((select count(*) from review_tags rt
                       join reviews r on r.id = rt.review_id
                      where r.content_id = p.content_id and rt.tag_code = any($4)), 0)::int as tag_hits,
           (select k.intro_raw->>'restdate' from kor_detail k where k.content_id = p.content_id) as restdate,
           regexp_replace(lower(p.title), '[^0-9a-z가-힣]', '', 'g') as norm_name,
           false as has_access_info,
           0::numeric as score, 0::numeric as hub_bonus
      from unsurveyed_dining p
     where p.ldong_regn_cd = $1
       and ($2::text is null or p.ldong_signgu_cd = $2)
  `, [region.regn, region.signgu, [...wantTypes], tagCodes.length ? tagCodes : ['__none__']])).rows;

  const neutral = w.get('base.neutral') ?? 50;
  const hubMax = w.get('base.hub_rank_max') ?? 30;
  const tagCap = w.get('party.review_tag_cap') ?? 45;

  for (const c of rows) {
    let s = neutral;
    // ⚠️ 인기순위 가산점은 여기서 더하지 않는다 — **관광 슬롯에서만** 쓴다.
    //  hub_rank 는 "관광 명소로서의 인기" 이고 맛집의 신호가 아니다. 그런데 전통시장은
    //  관광 명소로 등록돼 순위를 받고 음식점은 대부분 못 받는다. 식사 자리에서 이걸 더하면
    //  **세 끼가 전부 시장이 된다**(서울에서 실제로 9끼 전부 시장이 나왔다).
    //  등수가 낮을수록 조금 받는다(1위가 최대, 로그 스케일).
    c.hub_bonus = (c.hub_rank != null && c.hub_rank > 0)
      ? hubMax * Math.max(0, 1 - Math.log10(c.hub_rank) / 3)
      : 0;
    if (c.has_image) s += w.get('base.has_image') ?? 8;

    // 동반자 — 1순위 공식 양성 신호
    for (const p of party) {
      if (p === 'kids' && c.access_infant) s += w.get('party.official_positive') ?? 25;
      if (p === 'pet' && c.is_pet_ok) s += w.get('party.official_positive') ?? 25;
      // 효도여행은 예전에 지체 접근성(access_wheelchair)으로 근사했는데, 그러면
      //  "고령자 = 휠체어" 가 된다. 037 이 관광공사 5번째 유형을 되살렸으므로 그것을 쓴다.
      if (p === 'elderly' && c.access_elderly) s += w.get('party.accessibility') ?? 20;
    }
    // 2순위 후기 태그 — 상한을 둔다. 없으면 후기 많은 유명지가 전부 밀어낸다.
    if (c.tag_hits > 0) s += Math.min(tagCap, c.tag_hits * (w.get('party.review_tag') ?? 15));

    if (themeTypes.size && themeTypes.has(c.contenttypeid)) s += w.get('theme.match') ?? 20;
    c.score = s;
  }
  return rows;
}

/** `매주 X요일` 만 읽는다 — 나머지는 자유 텍스트라 v1 에서 판단하지 않는다(= 중립). */
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
export function closedWeekdays(restdate: string | null): Set<number> {
  const out = new Set<number>();
  if (!restdate) return out;
  // "매주 월요일", "매주 월,화요일", "매주 월요일 휴무" 등을 포괄한다.
  for (const m of restdate.matchAll(/매주\s*([월화수목금토일][,·\s]*)+요일/g)) {
    for (const ch of m[0]) {
      const i = WEEKDAYS.indexOf(ch);
      if (i >= 0) out.add(i);
    }
  }
  return out;
}

/** 두 지점의 대략 거리(km). 하루 안의 순서를 잡는 데만 쓴다 — Directions 는 v2. */
function distKm(a: Candidate, b: Candidate): number {
  if (a.mapx == null || a.mapy == null || b.mapx == null || b.mapy == null) return 50;
  const dx = (b.mapx - a.mapx) * Math.cos(((a.mapy + b.mapy) / 2) * Math.PI / 180) * 111.32;
  const dy = (b.mapy - a.mapy) * 110.57;
  return Math.sqrt(dx * dx + dy * dy);
}

function slotTypes(slot: Slot): string[] {
  if (slot === 'spot') return SPOT_TYPES;
  // 음식(39) + 쇼핑(38). 쇼핑을 남겨 두는 이유는 두 가지다 —
  //  ① 전통시장은 실제 식사 목적지다(주문진수산시장·망원시장)
  //  ② 후보가 적은 지역은 음식점이 몇 곳뿐이다(가평 3곳). 막으면 칸이 통째로 빈다.
  //  대신 시장이 아닌 쇼핑(백화점·몰)은 아래에서 점수로 크게 민다.
  return [FOOD_TYPE, '38'];
}

/** 식사 자리에 어울리는 쇼핑인가 — 전통시장은 되고 백화점·아울렛은 아니다. */
function isMarket(name: string): boolean {
  return /시장/.test(name) && !/백화점|아울렛|몰$/.test(name);
}

/** 이 후보가 그 슬롯에 놓일 수 있는가. 카페만 추가 조건이 있다. */
function fitsSlot(c: Candidate, slot: Slot): boolean {
  if (!slotTypes(slot).includes(c.contenttypeid)) return false;
  // 무장애 조사를 받지 않은 곳은 **식사·카페 자리에만** 들어간다. 볼거리는 부족하지 않으므로
  //  굳이 접근성을 모르는 곳을 섞을 이유가 없다(collectCandidates 주석).
  if (!c.has_access_info && slot === 'spot') return false;
  if (slot === 'cafe') return c.is_cafe;
  if (c.is_cafe) return false;   // 식사 슬롯에 카페가 들어가지 않게
  return true;
}

export type RecommendDay = {
  date: string;
  congestion: number | null;      // 그날 지역 평균 혼잡도(백분위). null = 데이터 없음
  busy: boolean;
  items: {
    slot: Slot; contentID: string; name: string; categoryLabel: string;
    imageURL: string | null; latitude: number | null; longitude: number | null;
    /**
     * 무장애 조사를 받은 곳인가. **false 는 "접근성이 나쁘다"가 아니라 "모른다"** 다.
     * 앱은 이 값이 false 인 카드에 조사되지 않았음을 표시해야 한다 — 조용히 섞으면
     * 사용자가 조사된 곳으로 오해하고, 그것이 무장애 앱에서 가장 나쁜 거짓말이다.
     */
    hasAccessInfo: boolean;
  }[];
};

export type RecommendResult = {
  region: string;
  days: RecommendDay[];
  stay: { contentID: string; name: string; imageURL: string | null } | null;
  notes: RecommendNote[];
};

export async function recommend(input: RecommendInput): Promise<RecommendResult | null> {
  const region = await resolveRegion(input);
  if (!region) return null;

  const w = await weights();
  const party = (input.party ?? []).filter((p): p is PartyKind => PARTY_KINDS.has(p));
  const notes: RecommendNote[] = [];

  const all = await collectCandidates(region, party, input.themes ?? [], w);
  // ⚠️ 후보가 없으면 **빈 코스를 200 으로 돌려주지 않는다.** 앱이 항목 0개인 일정을 그리면
  //    사용자는 "추천이 실패했다" 가 아니라 "이 지역엔 갈 곳이 없다" 로 읽는다.
  //    (실제로 세종 슬러그가 잘못된 코드를 가리켜 이 상태가 나왔다 — 034 참고)
  if (all.length === 0) {
    return { region: region.label, days: [], stay: null, notes: ['empty_pool'] };
  }

  // ── 날짜별 혼잡도. 명세 3번: 시간대가 아니라 **날짜 단위**로 배치한다.
  const dates: string[] = [];
  for (let d = new Date(input.startDate); d <= new Date(input.endDate); d.setDate(d.getDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  const cong = new Map<string, number>();
  if (dates.length) {
    // 미리 집계한 tats_region_daily 를 읽는다(036). 예전에는 요청마다 tats_cnctr 66만 행을
    //  훑었고, 그 테이블은 440MB 라 prod 로 옮길 수도 없어 혼잡도가 항상 null 이었다.
    //  ⚠️ regn 을 앞 2자리로 자른다 — 세종만 ldong_regn_cd 가 '36110'(5자리)이다(018·034 참고).
    const rows = (await query<{ ymd: string; rate: string }>(
      'select base_ymd as ymd, rate from tats_region_daily where regn_cd = $1 and base_ymd = any($2)',
      [region.regn.slice(0, 2), dates.map((d) => d.replace(/-/g, ''))],
    )).rows;
    for (const r of rows) {
      cong.set(`${r.ymd.slice(0, 4)}-${r.ymd.slice(4, 6)}-${r.ymd.slice(6, 8)}`, Number(r.rate));
    }
  }
  if (cong.size === 0) notes.push('no_congestion_data');

  // ── 혼잡 임계.
  //  ⚠️ **여행 기간 안에서 상대 비교를 하면 안 된다.** 3박이면 값 3개로 등수를 매기게 되는데,
  //     강원 실측 분포가 26.9~79.6 인 상황에서 27.2·27.6·27.7(전부 연중 최하위권)을 놓고
  //     27.7 을 "혼잡" 으로 찍는 일이 실제로 벌어졌다. 한산한 날에 "붐빌 테니 가볍게" 라고
  //     안내하면 추천이 통째로 틀린 것이 된다.
  //  그래서 그 지역이 **평소 얼마나 붐비는지**의 분포에서 임계를 잡는다.
  const pct = (w.get('congestion.threshold') ?? 70) / 100;
  const busyCut = (await query<{ cut: string | null }>(
    `select percentile_cont($2) within group (order by rate)::numeric(6,2) as cut
       from tats_region_daily where regn_cd = $1`,
    [region.regn.slice(0, 2), pct],
  )).rows[0]?.cut;
  const busyThreshold = busyCut == null ? Infinity : Number(busyCut);

  // ── 숙박 선택 (명세 2-1 폴백 포함)
  let stay: Candidate | null = null;
  if (!input.dayTripOnly && dates.length > 1) {
    const pool = all.filter((c) => c.contenttypeid === STAY_TYPE
      && !EXCLUDED_STAY.includes(c.lcls_systm3 ?? ''));
    const tiers = input.budget ? [input.budget, ...(BUDGET_FALLBACK[input.budget] ?? [])] : [];
    for (const [i, t] of tiers.entries()) {
      const codes = BUDGET_CODES[t] ?? [];
      const hit = pool.filter((c) => codes.includes(c.lcls_systm3 ?? ''));
      if (hit.length) {
        stay = hit.sort((a, b) => b.score - a.score)[0]!;
        if (i > 0) notes.push('budget_fallback');
        break;
      }
    }
    if (!stay && pool.length) {
      // 명세: 그래도 없으면 가격대 배지 없이 전체 숙박 + 안내 문구
      stay = pool.sort((a, b) => b.score - a.score)[0]!;
      if (input.budget) notes.push('budget_ignored');
    }
  }

  // ── 날짜별 배치. 혼잡일에는 주요 명소(hub_rank 상위)를 피하고 가벼운 일정을 둔다.
  const used = new Set<string>();
  // contentid 와 별개로 **이름**도 막는다. 같은 곳이 다른 id 로 두 번 들어 있기 때문이다.
  const usedNames = new Set<string>();
  if (stay) { used.add(stay.contentid); usedNames.add(stay.norm_name); }
  const days: RecommendDay[] = [];
  let thin = false;

  for (const date of dates) {
    const rate = cong.get(date) ?? null;
    const busy = rate != null && rate >= busyThreshold;
    const dow = new Date(date).getDay();
    const items: RecommendDay['items'] = [];
    let prev: Candidate | null = stay;
    // 그날 이미 쓴 유형. 같은 유형이 반복되면 감점한다 — 하루가 통째로 '관광지 4곳' 이 되면
    //  코스가 단조로워지고, 명세 3번이 경계한 "경쟁 목록처럼 보이는" 문제와 같은 성질이다.
    const typesToday = new Map<string, number>();

    for (const slot of DAY_TEMPLATE) {
      const pick = all
        .filter((c) => !used.has(c.contentid) && !usedNames.has(c.norm_name) && fitsSlot(c, slot))
        .filter((c) => !closedWeekdays(c.restdate).has(dow))   // 휴무일 제외
        .map((c) => {
          let s = c.score;
          // 인기순위는 볼거리를 고를 때만 쓴다(위 주석).
          if (slot === 'spot') s += c.hub_bonus;
          // 혼잡일 보정 — 유명한 곳일수록 크게 깎는다(hub_rank 가 있는 24% 에만 적용된다)
          if (c.hub_rank != null) {
            s += busy ? -(w.get('congestion.busy_penalty') ?? 15)
                      : (w.get('congestion.quiet_bonus') ?? 10);
          }
          // 이동 거리 — 직전 장소에서 멀수록 감점. Directions 없이 하루 동선을 뭉치는 장치다.
          if (prev) s -= Math.min(30, distKm(prev, c) * 1.5);
          // 무장애 조사를 받은 곳을 먼저 쓴다. 막지 않고 뒤로 미는 것이다 —
          //  가평처럼 조사된 식당이 1곳뿐인 지역에서 그 한 곳이 첫 끼에 쓰이고,
          //  나머지 여덟 끼를 조사되지 않은 곳이 채운다. 우선순위가 뒤바뀌지 않게 한다.
          if (!c.has_access_info) s += w.get('access.unsurveyed') ?? -18;
          // 식사 자리의 쇼핑 — 서울처럼 백화점이 인기순위 상위에 몰린 지역에서는
          //  그대로 두면 세 끼가 전부 백화점이 된다(실제로 그랬다). 시장은 예외로 둔다.
          if (slot !== 'cafe' && c.contenttypeid === '38' && !isMarket(c.title)) {
            s += w.get('meal.non_restaurant') ?? -35;
          }
          // 식사 시간대 — 아침에 횟집, 저녁에 죽집이 오지 않게. 거르지 않고 점수만 민다.
          if (slot === 'meal_morning' || slot === 'meal_dinner') {
            const want = slot === 'meal_morning' ? 'morning' : 'evening';
            const got = mealTime(c.kakao_cat);
            if (got === want) s += w.get('meal.time_match') ?? 20;
            else if (got !== 'any') s += w.get('meal.time_mismatch') ?? -25;
          }
          // 다양성 — 그날 같은 유형이 나올 때마다 누적 감점.
          const seen = typesToday.get(c.contenttypeid) ?? 0;
          if (seen > 0) s += seen * (w.get('diversity.same_type') ?? -10);
          return { c, s };
        })
        .sort((a, b) => b.s - a.s)[0];

      if (!pick) { thin = true; continue; }
      used.add(pick.c.contentid);
      usedNames.add(pick.c.norm_name);
      prev = pick.c;
      typesToday.set(pick.c.contenttypeid, (typesToday.get(pick.c.contenttypeid) ?? 0) + 1);
      items.push({
        hasAccessInfo: pick.c.has_access_info,
        slot, contentID: pick.c.contentid, name: pick.c.title,
        categoryLabel: pick.c.is_cafe ? '카페' : (TYPE_LABEL[pick.c.contenttypeid] ?? '기타'),
        imageURL: pick.c.firstimage,
        latitude: pick.c.mapy, longitude: pick.c.mapx,
      });
    }
    days.push({ date, congestion: rate, busy, items });
  }
  if (thin) notes.push('thin_pool');
  if (days.some((d) => d.items.some((i) => !i.hasAccessInfo))) notes.push('includes_unsurveyed');

  return {
    region: region.label,
    days,
    stay: stay ? { contentID: stay.contentid, name: stay.title, imageURL: stay.firstimage } : null,
    notes,
  };
}
