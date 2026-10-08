// 랜딩 페이지(/) — 슬로건 한 문장, 앱 아이콘, 스토어 배지 두 개만 둔다.
//
// ── 왜 이 서버가 뱉나
//  moduwa.app 루트가 이 서버를 가리키고, 같은 도메인에 유니버설 링크 파일 · 공유 대체 페이지 ·
//  스토어에 등록한 방침/지원 URL 이 걸려 있다. 랜딩만 다른 호스팅으로 옮기면 그것들을 함께
//  옮겨야 한다 — 그래서 약관 페이지(legal-pages.ts)처럼 문자열로 뱉는다.
//
// ⚠️ 앱 아이콘은 그림 파일이 아니라 로고 도형(LOGO_PATHS)을 라임 바탕에 올려 그린다.
//    정적 파일을 두지 않는 이유는 legal-pages.ts 의 LOGO 주석과 같다.
import { readFileSync } from 'node:fs';
import { config } from '../config';
import { LOGO_PATHS } from './legal-pages';

/** 브랜드 라임 — iOS `LaunchBackground` · `Color.moduwaGreen` 과 같은 값. */
const LIME = '#A7E100';

/**
 * 슬로건 — iOS 온보딩 첫 장(`OnboardingView` intro, 시안 868:150)의 소개 문장 그대로다.
 *  ⚠️ **문구의 정본은 앱이다.** 앱에서 바뀌면 여기도 같이 바꾼다. 줄바꿈 위치도 앱과 같다.
 */
const SLOGAN = '나이, 장애에 상관없이, 누구와 함께하든,<br>모두의 즐거운 여행을 바라는 모두와에요.';

/**
 * 앱 아이콘 — 1024 격자. 로고 원본 좌표(47 × 31.2)를 17.06 배 해서 (145.7, 311.7) 에 둔다.
 *
 * ⚠️ 배치는 iOS `AppIcon.png`(1024px)에서 흰 도형의 경계 상자(150,316 – 941,840)를 재서
 *    맞췄다. 도형이 가운데가 아니라 오른쪽 아래로 치우친 것도 원본 그대로다(화살표 끝 때문).
 *    아이콘을 바꾸면 다시 잰다.
 *  모서리 230 은 iOS 아이콘 마스크(약 22.4%)에 맞춘 근삿값이다.
 */
const ICON = `<svg class="icon" viewBox="0 0 1024 1024" role="img" aria-label="모두와" xmlns="http://www.w3.org/2000/svg">
<rect width="1024" height="1024" rx="230" fill="${LIME}"/>
<g transform="translate(145.7 311.7) scale(17.06)" color="#FFFFFF">${LOGO_PATHS}</g>
</svg>`;

/**
 * 스토어 배지 — **공식 아트워크를 손대지 않고** 쓴다(두 스토어 가이드라인 모두 수정을 금한다).
 *  · App Store: Apple 마케팅 툴박스(toolbox.marketingtools.apple.com) › 모두와 › 배지 및 락업,
 *    블랙 · 한국어(원본 이름 Download_on_the_App_Store_Badge_KR_RGB_blk_100317)
 *  · Google Play: Partner Marketing Hub › Google Play › Badges › Digital › svg
 *    (GetItOnGooglePlay_Badge_Web_color_Korean.svg)
 *  2026-10-08 에 받았다. 새 버전이 나오면 같은 곳에서 받아 assets/ 의 파일만 갈아 끼운다.
 *
 * ⚠️ 인라인 <svg> 가 아니라 data URI <img> 로 넣는다. 구글 배지는 `.st0` 같은 전역 클래스
 *    스타일을 품고 있어 본문에 풀면 페이지 CSS 와 섞인다 — 이미지로 두면 서로 닿지 않는다.
 *    외부 주소로 걸지 않는 것도 의도다. 구글의 다운로드 링크는 하루 뒤 만료되는 서명 URL 이다.
 */
const badgeSrc = (file: string): string =>
  `data:image/svg+xml;base64,${readFileSync(new URL(`./assets/${file}`, import.meta.url)).toString('base64')}`;
const APP_STORE_BADGE = badgeSrc('app-store-badge-ko.svg');
const GOOGLE_PLAY_BADGE = badgeSrc('google-play-badge-ko.svg');

const attr = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 대체 텍스트는 배지에 적힌 문구 그대로다 — 그림 속 글자가 곧 링크 이름이다. */
const badge = (href: string, src: string, alt: string): string =>
  `<a class="store" href="${attr(href)}"><img src="${src}" alt="${alt}" height="48"></a>`;

const STYLE = `
  :root{--bg:#fff;--text:#4D4D4D;--muted:#5B6B73;--focus:#075B39}
  @media (prefers-color-scheme:dark){:root{--bg:#12181B;--text:#C8D0D4;--muted:#9BAAB1;--focus:${LIME}}}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;background:var(--bg);
       font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Pretendard','Noto Sans KR',sans-serif;
       -webkit-text-size-adjust:100%}
  main{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:40px;padding:48px 16px}
  /* 글자색은 앱의 textSecondary(#4D4D4D, 흰 바탕 8.4:1) — 온보딩에서 이 문장이 쓰는 색이다. */
  .slogan{margin:0;text-align:center;font-size:18px;line-height:1.6;letter-spacing:-.02em;color:var(--text);
          word-break:keep-all}
  h1{margin:0;line-height:0}
  .icon{width:160px;max-width:40vw;height:auto;display:block;filter:drop-shadow(0 4px 14px rgba(11,42,28,.14))}
  /* ⚠️ 두 배지는 **같은 높이**다. 두 가이드라인이 저마다 "다른 스토어 배지보다 작지 않게" 를
        요구해, 같게 두는 것이 둘을 함께 지키는 길이다. 높이 48 은 Apple 최소(40)를 넘고,
        간격 16 은 두 가이드라인의 여백(배지 높이의 1/4 = 12)을 넘는다. 375px 폭에서 한 줄에 든다. */
  .stores{display:flex;flex-wrap:wrap;justify-content:center;gap:16px}
  .store{display:block;border-radius:8px;line-height:0}
  .store img{display:block;height:48px;width:auto}
  .store:focus-visible,footer a:focus-visible{outline:3px solid var(--focus);outline-offset:3px}
  footer{padding:16px 16px 28px;text-align:center;font-size:13px;line-height:1.8;color:var(--muted)}
  footer a{color:var(--muted)}
`;

export const landingPage = (): string => {
  const { appStoreUrl, playStoreUrl, origin } = config.web;
  // 주소가 빈 스토어는 버튼을 만들지 않는다 — 누를 곳 없는 버튼은 헛걸음이다(app.ts storeButtons).
  const stores = [
    appStoreUrl ? badge(appStoreUrl, APP_STORE_BADGE, 'App Store에서 다운로드 하기') : '',
    playStoreUrl ? badge(playStoreUrl, GOOGLE_PLAY_BADGE, 'Google Play에서 다운로드') : '',
  ].join('');
  const description = '휠체어·시각·청각·유아 동반·고령자 등 저마다의 조건에 맞는 무장애 여행지를 찾고, 같은 조건으로 다녀온 사람의 후기를 볼 수 있는 앱';

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>모두와 — 무장애 여행</title>
<meta name="description" content="${description}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="모두와">
<meta property="og:title" content="모두와 — 무장애 여행">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${attr(origin)}/">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(ICON)}">
<style>${STYLE}</style></head><body>
<main>
<p class="slogan">${SLOGAN}</p>
<h1>${ICON}</h1>
<div class="stores" role="group" aria-label="앱 다운로드">${stores}</div>
</main>
<footer><a href="/privacy">개인정보 처리방침</a> · <a href="/terms">이용약관</a> · <a href="/support">고객 지원</a></footer>
</body></html>`;
};
