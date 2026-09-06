// 이미지 URL 정규화 — 수집 원본이 http 로 주는 것을 https 로 올린다.
//
//  ⚠️ **이건 취향 문제가 아니라 안 보이냐 보이냐의 문제다.** 우리 페이지는 https 로 서빙되고
//     브라우저는 https 문서 안의 http 이미지를 혼합 콘텐츠로 **차단한다**. 에러도 안 띄운다 —
//     그냥 안 나온다. 2026-09-07 기준 수집 테이블의 http 이미지가 37,018건이고 전부
//     tong.visitkorea.or.kr 인데, 올리지 않으면 사진 갤러리 절반이 "링크 깨짐" 으로 보인다.
//     (같은 경로가 https 로도 바이트 단위로 같은 응답을 준다는 것을 확인하고 올린다.)
//
//  ⚠️ **아는 호스트만 올린다.** 모든 http 를 https 로 바꾸면 https 를 안 하는 서버의 이미지가
//     조용히 사라진다. 올려도 되는 곳을 확인한 만큼만 적는다.
const HTTPS_SAFE_HOSTS = /^http:\/\/(tong\.visitkorea\.or\.kr|place\.map\.kakao\.com|.*\.daumcdn\.net)\//;

export const toHttps = (url: unknown): string | null => {
  if (typeof url !== 'string' || !url.trim()) return null;
  const u = url.trim();
  return HTTPS_SAFE_HOSTS.test(u) ? u.replace(/^http:/, 'https:') : u;
};
