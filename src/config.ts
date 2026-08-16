import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`환경변수 ${name} 가 설정되지 않았습니다. .env 를 확인하세요.`);
  }
  return v.trim();
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v == null || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  databaseUrl: required('DATABASE_URL'),

  // 공공데이터포털 / TourAPI — serviceKey는 fetch에만 필요(migrate·stats는 DB만)
  serviceKey: process.env.DATA_GO_KR_SERVICE_KEY?.trim() ?? '',
  baseUrl:
    process.env.TARRLTE_BASE_URL?.trim() ||
    'http://apis.data.go.kr/B551011/TarRlteTarService1/areaBasedList1',
  mobileApp: process.env.MOBILE_APP?.trim() || 'moduwa',
  mobileOs: process.env.MOBILE_OS?.trim() || 'ETC',

  // 수집 범위 (기준연월). 실제 데이터: 202405 ~ 202605
  baseYmStart: process.env.BASE_YM_START?.trim() || '202405',
  baseYmEnd: process.env.BASE_YM_END?.trim() || '202605',

  // 수집 튜닝
  numOfRows: num('INGEST_NUM_OF_ROWS', 5000), // 시군구당 보통 1요청으로 끝나도록 크게
  requestDelayMs: num('INGEST_REQUEST_DELAY_MS', 150),
  maxRetries: num('INGEST_MAX_RETRIES', 5),

  // 일일 요청 상한 — 개발계정 1,000건/일. 여유 두고 자동 중단(다음날 재개).
  // 0 = 무제한(API의 한도초과 에러에 의존).
  dailyRequestCap: num('INGEST_DAILY_REQUEST_CAP', 900),

  // KorService2 상세 enrich 대상 콘텐츠 유형.
  // 숙박(32)·음식점(39)은 모두와 앱의 장소 상세(설명·운영시간·기본정보)에 필요해 포함. 쇼핑(38)만 제외.
  // 전체를 원하면 8종 모두 나열: 12,14,28,15,25,32,38,39
  kordetailTypes: (process.env.KORDETAIL_CONTENT_TYPES?.trim() || '12,14,28,15,25,32,39')
    .split(',').map((s) => s.trim()).filter(Boolean),

  // 카카오 로컬 API (전화·카테고리·지도링크 보완). 발급: developers.kakao.com
  kakaoRestApiKey: process.env.KAKAO_REST_API_KEY?.trim() ?? '',
  kakaoDailyCap: num('KAKAO_DAILY_CAP', 90000), // 카카오 무료 10만/일 — 여유 두고
  kakaoConcurrency: num('KAKAO_CONCURRENCY', 8),

  // ── REST API 서버(배포용) ──
  api: {
    port: num('PORT', 8080),
    // 허용할 API 키 목록(콤마 구분). 비면 인증 비활성(로컬 개발용) — 배포 시 반드시 설정.
    keys: (process.env.API_KEYS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    // CORS 허용 오리진(콤마 구분). '*' 또는 비면 전체 허용(브라우저에서 직접 호출 안 하면 무관).
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '*').split(',').map((s) => s.trim()).filter(Boolean),
    // 키당 분당 요청 상한.
    rateLimitPerMin: num('RATE_LIMIT_PER_MIN', 120),

    // ── 후기 사진 업로드 ──
    // Railway 볼륨 마운트 경로. 이 디렉터리에 쓸 수 없으면 업로드는 503 으로 명확히
    // 실패한다 — 컨테이너 임시 파일시스템에 조용히 쓰면 재배포 때 사진이 사라지는데
    // 그게 조용히 일어나는 게 최악이다.
    uploadDir: process.env.UPLOAD_DIR?.trim() || '/data',
    // 장당 상한. iOS 가 장변 1280px·JPEG q0.8 로 줄여 올리므로 실제로는 200~450KB다.
    // 예상치의 4~5배로 두어 정상 업로드를 막지 않으면서 방어선 역할만 하게 한다.
    maxImageBytes: num('MAX_IMAGE_BYTES', 2 * 1024 * 1024),
    // 요청 전체 상한(5장 × 2MB).
    maxUploadBytes: num('MAX_UPLOAD_BYTES', 10 * 1024 * 1024),
  },

  // ── 수집 현황 대시보드(/dashboard) ──
  //  비밀번호가 비어 있으면 라우트 자체를 등록하지 않는다 — 환경변수를 깜빡한 채 배포해도
  //  "인증 없이 열린 대시보드"가 생기지 않게 하는 게 안전한 기본값이다.
  dashboard: {
    password: process.env.DASHBOARD_PASSWORD?.trim() ?? '',
    // 세션 쿠키 서명 키. 비우면 비밀번호에서 파생한다(= 비밀번호를 바꾸면 기존 세션 자동 무효).
    sessionSecret: process.env.DASHBOARD_SESSION_SECRET?.trim() ?? '',
    sessionHours: num('DASHBOARD_SESSION_HOURS', 12),
    // 집계·조회 1건당 상한. 3.8GB짜리 tar_rlte_records 같은 테이블이 페이지 전체를
    // 붙잡지 않도록 타임아웃을 걸고, 넘으면 그 칸만 '측정 생략'으로 표시한다.
    queryTimeoutMs: num('DASHBOARD_QUERY_TIMEOUT_MS', 8000),
    queryRowLimit: num('DASHBOARD_QUERY_ROW_LIMIT', 500),
  },
};

/** 'YYYYMM' 범위를 배열로 (최신월 우선 정렬은 호출부에서). */
export function monthRange(start: string, end: string): string[] {
  const out: string[] = [];
  let y = Number(start.slice(0, 4));
  let m = Number(start.slice(4, 6));
  const ey = Number(end.slice(0, 4));
  const em = Number(end.slice(4, 6));
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}
