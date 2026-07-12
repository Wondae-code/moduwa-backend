import { config } from './config';

export type ApiItem = Record<string, unknown>;

export interface ApiResult {
  pageNo: number;
  numOfRows: number;
  totalCount: number;
  resultCode: string;
  resultMsg: string;
  items: ApiItem[];
}

/** 일일 요청 한도 초과(공공데이터포털 코드 22). 잡으면 그날 수집을 깔끔히 중단. */
export class DailyLimitError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'DailyLimitError';
  }
}

const SUCCESS = new Set(['0000', '00', '000', '0']);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parsePortalError(text: string): { code: string; msg: string } | null {
  if (!text.trimStart().startsWith('<')) return null;
  const code = /<returnReasonCode>\s*([^<]+)<\/returnReasonCode>/.exec(text)?.[1]?.trim();
  const msg =
    /<returnAuthMsg>\s*([^<]+)<\/returnAuthMsg>/.exec(text)?.[1]?.trim() ??
    /<errMsg>\s*([^<]+)<\/errMsg>/.exec(text)?.[1]?.trim() ??
    'SERVICE ERROR';
  return { code: code ?? '?', msg };
}

function normalizeItems(body: unknown): ApiItem[] {
  const b = body as Record<string, unknown> | null | undefined;
  const items = b?.['items'];
  if (items == null || items === '') return [];
  if (Array.isArray(items)) return items as ApiItem[];
  const item = (items as Record<string, unknown>)['item'];
  if (item == null) return [];
  return Array.isArray(item) ? (item as ApiItem[]) : [item as ApiItem];
}

/**
 * 범용 TourAPI/KTO 호출. operationUrl = 엔드포인트+오퍼레이션(예: ".../KorService2/areaBasedList2").
 * 공통 파라미터(serviceKey, MobileOS, MobileApp, _type)는 자동 부착. extra로 나머지 전달.
 * 구형(response.header/body)·신형(플랫 에러)·XML 포털에러를 모두 정규화.
 */
export async function fetchApi(
  operationUrl: string,
  extra: Record<string, string | number>,
): Promise<ApiResult> {
  if (!config.serviceKey) {
    throw new Error('DATA_GO_KR_SERVICE_KEY 가 비어 있습니다. .env를 확인하세요.');
  }

  const url = new URL(operationUrl);
  url.searchParams.set('serviceKey', config.serviceKey);
  url.searchParams.set('MobileOS', config.mobileOs);
  url.searchParams.set('MobileApp', config.mobileApp);
  url.searchParams.set('_type', 'json');
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, String(v));

  let lastErr: unknown;
  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      const text = await res.text();

      const portalErr = parsePortalError(text);
      if (portalErr) {
        if (portalErr.code === '22') {
          throw new DailyLimitError(`일일 요청 한도 초과(22): ${portalErr.msg}`);
        }
        throw new Error(`포털 에러[${portalErr.code}]: ${portalErr.msg}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);

      const json = JSON.parse(text) as Record<string, unknown>;

      // 신형 플랫 에러: { resultCode, resultMsg } (response 래퍼 없음)
      if (json['response'] == null && json['resultCode'] != null) {
        const code = String(json['resultCode']);
        if (!SUCCESS.has(code)) {
          throw new Error(`API 에러[${code}]: ${json['resultMsg'] ?? ''}`);
        }
      }

      const response = (json['response'] ?? json) as Record<string, unknown>;
      const header = (response['header'] ?? {}) as Record<string, unknown>;
      const body = (response['body'] ?? {}) as Record<string, unknown>;

      return {
        pageNo: Number(body['pageNo'] ?? extra['pageNo'] ?? 1),
        numOfRows: Number(body['numOfRows'] ?? extra['numOfRows'] ?? 0),
        totalCount: Number(body['totalCount'] ?? 0),
        resultCode: String(header['resultCode'] ?? json['resultCode'] ?? ''),
        resultMsg: String(header['resultMsg'] ?? json['resultMsg'] ?? ''),
        items: normalizeItems(body),
      };
    } catch (err) {
      if (err instanceof DailyLimitError) throw err;
      lastErr = err;
      if (attempt < config.maxRetries) {
        const backoff = Math.min(1000 * 2 ** (attempt - 1), 15_000);
        console.warn(
          `[fetch] ${operationUrl.split('/').pop()} 시도 ${attempt}/${config.maxRetries} 실패: ` +
            `${(err as Error).message} → ${backoff}ms 후 재시도`,
        );
        await sleep(backoff);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(
    `fetch 실패 (${operationUrl}, ${config.maxRetries}회): ${(lastErr as Error)?.message}`,
  );
}

export function isSuccess(resultCode: string): boolean {
  return resultCode === '' || SUCCESS.has(resultCode);
}

// ── 하위호환: 연관관광지(TarRlteTarService1) 수집이 쓰는 기존 시그니처 ──
export interface AreaBasedParams {
  baseYm: string;
  areaCd: string;
  signguCd: string;
  pageNo: number;
}
export type TarRlteItem = ApiItem;
export type PageResult = ApiResult;

export function fetchAreaBasedList(p: AreaBasedParams): Promise<ApiResult> {
  return fetchApi(config.baseUrl, {
    pageNo: p.pageNo,
    numOfRows: config.numOfRows,
    baseYm: p.baseYm,
    areaCd: p.areaCd,
    signguCd: p.signguCd,
  });
}
