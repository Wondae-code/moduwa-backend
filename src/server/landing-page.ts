// moduwa.app 랜딩 페이지 — 서버가 직접 서빙한다(GET /, 브라우저 요청일 때만).
//
// ── 왜 서버가 뱉나
//  moduwa.app 루트가 이미 이 서버를 가리킨다(config.web). 처리방침·약관·초대 대체 페이지가 모두
//  여기서 나가므로 웹서버를 따로 두지 않는다 — legal-pages.ts 와 같은 이유다. 스토어 링크도 같은
//  환경변수(APP_STORE_URL · PLAY_STORE_URL)를 읽어 /i/ · /p/ 대체 페이지와 늘 같은 곳을 가리킨다.
//
// ── 디자인 시스템
//  색·글꼴 토큰은 디자인팀 design-system.md(Moduwa Green)의 CSS 변수를 **한 글자도 바꾸지 않고**
//  옮겼다(STYLE 맨 위 :root). 그 밖의 색은 전부 이 변수를 가리킨다 — 여기서 새 색을 만들지 않는다.
//  ⚠️ 폐기 컬러(#FAFAFA · #14213D · #1E9E6B · 오렌지 · #A4DD00)는 쓰지 않는다.
//  ⚠️ 글꼴은 Pretendard(디자인 시스템 기준). iOS 앱은 Noto Sans KR 을 쓰지만 웹은 디자인 시스템을
//     따르기로 했다(2026-09-23).
//
// ── 무엇을 보여주나 (지금은 Hero 한 섹션)
//  카피 · 스토어 버튼 · 다섯 가지 배려 안내표지 · 앱 화면 목업(홈 + 플랜).
//  목업은 스크린샷이 아니라 HTML 로 다시 그린 것이다 — 문구는 앱 코드(HeroCard.swift · HomeView.swift ·
//  PlanDraft.swift)와 번들 데이터(HomeFeed.json)의 실제 값이다. 앱 문구가 바뀌면 여기도 고친다.
//
// ⚠️ **숫자는 README 의 barrier_free 현황과 같아야 한다**(무장애 여행지 10,265곳). 데이터가 크게
//    바뀌면 카피도 함께 고친다 — 부풀린 숫자는 신뢰를 파는 이 서비스에서 가장 비싼 실수다.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { LOGO } from './legal-pages';
import { ACCESS, CATEGORY, TAB, UI } from './landing-icons';

const esc = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ── 정적 자산 (표지 사진) ─────────────────────────────────────────────────────
//  앱의 지역 표지(iOS `cover_*.imageset`)를 720px 로 줄인 사본이다. 기동 때 한 번 읽어 메모리에
//  들고 있다(합쳐서 ~175KB). URL 에 내용 해시를 붙여 캐시를 영구로 건다 — 사진을 바꾸면 해시가
//  바뀌어 새 URL 이 된다.
//
// ⚠️ Dockerfile 은 `src/` 만 복사한다. 자산을 src 밖에 두면 배포본에서 기동이 실패한다.
const ASSET_DIR = join(import.meta.dirname, 'assets', 'landing');
const ASSET_FILES = ['cover_gyeongju.jpg', 'cover_jeju.jpg'] as const;

type Asset = { body: Uint8Array<ArrayBuffer>; mime: string; hash: string };
const assets = new Map<string, Asset>(ASSET_FILES.map((name) => {
  const body = new Uint8Array(readFileSync(join(ASSET_DIR, name)));
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 10);
  return [name, { body, mime: 'image/jpeg', hash }];
}));

/** 랜딩 자산 하나. 목록에 없는 이름이면 null — 경로 조작을 원천 차단한다. */
export function landingAsset(name: string): Asset | null {
  return assets.get(name) ?? null;
}

const assetUrl = (name: (typeof ASSET_FILES)[number]): string =>
  `/assets/landing/${name}?v=${assets.get(name)!.hash}`;

// ── 페이지 ───────────────────────────────────────────────────────────────────
export type LandingOptions = {
  /** https://moduwa.app — og:url · canonical */
  origin: string;
  /** 비어 있으면 그 스토어는 "준비 중"으로 보인다 */
  appStoreUrl: string;
  playStoreUrl: string;
};

const PHONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="6" y="2.5" width="12" height="19" rx="3"/><path d="M10.5 18.5h3"/></svg>';
const ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 12h15m-6-6 6 6-6 6"/></svg>';
const CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m9 5 7 7-7 7"/></svg>';
const TICKET = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4z"/><path d="M14 6v12" stroke-dasharray="2 2"/></svg>';

/** 스토어 버튼. URL 이 없으면 누를 수 없는 "준비 중" 표시로 바뀐다(링크로 두지 않는다). */
function storeButton(url: string, platform: string, store: string): string {
  const txt = (label: string) =>
    `<span class="store__txt"><small>${platform}</small><b>${label}</b></span>`;
  return url
    ? `<a class="store store--live" href="${esc(url)}">${PHONE}${txt(`${store}에서 받기`)}</a>`
    : `<p class="store store--soon">${PHONE}${txt(`${store} 준비 중`)}</p>`;
}

/** App Store URL 에서 앱 ID 를 꺼낸다 — 사파리 스마트 앱 배너용. 못 찾으면 배너를 달지 않는다. */
const appleAppId = (url: string): string | null => /\/id(\d+)/.exec(url)?.[1] ?? null;

export function landingPage(opts: LandingOptions): string {
  const { origin, appStoreUrl, playStoreUrl } = opts;
  const appId = appleAppId(appStoreUrl);
  const stores = storeButton(appStoreUrl, 'iPhone', 'App Store') + storeButton(playStoreUrl, 'Android', 'Google Play');
  const title = '모두와 — 그 어떤 누구일지라도, 함께할 수 있는 여행';
  const desc = '휠체어·유모차·어르신과 함께하는 여행도 걱정 없이. 한국관광공사 무장애 여행지 10,265곳의 접근성 정보로 여행 코스를 추천해요.';

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(origin)}/">
<meta name="theme-color" content="#CAF354">
<meta property="og:type" content="website">
<meta property="og:site_name" content="모두와">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(origin)}/">
${appId ? `<meta name="apple-itunes-app" content="app-id=${appId}">` : ''}
<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard-dynamic-subset.min.css">
<style>${STYLE}</style>
</head>
<body>
<a class="skip" href="#download">앱 받기로 건너뛰기</a>

<section class="hero" aria-labelledby="hero-title">
  <div class="hero__inner">

    <header class="topbar">
      <a class="topbar__logo" href="/" aria-label="모두와 홈">${LOGO}</a>
      <a class="topbar__cta" href="#download">앱 받기</a>
    </header>

    <div class="hero__grid">
      <div class="hero__copy">
        <p class="tag"><span class="tag__pict" aria-hidden="true">${ACCESS.wheelchair}</span>접근성 중심 여행 코스 추천</p>

        <h1 class="hero__title" id="hero-title">그 어떤 누구일지라도,<br><em>함께할 수 있는</em> 여행</h1>

        <p class="hero__lede">휠체어, 유모차, 어르신과 함께하는 여행도 걱정 없이.
          한국관광공사가 조사한 <strong>무장애 여행지 10,265곳</strong>의 접근성 정보로
          <strong>우리에게 맞는 여행 코스</strong>를 추천해요.</p>

        <div class="stores" id="download">${stores}</div>

        <ul class="facts" aria-label="이용 안내">
          <li>무료</li>
          <li>로그인 없이 둘러보기</li>
          <li>광고·추적 없음</li>
        </ul>

        <nav class="sign" aria-label="모두와가 배려하는 다섯 가지">
          <span class="sign__item">${ACCESS.wheelchair}휠체어</span>
          <span class="sign__item">${ACCESS.visual}시각</span>
          <span class="sign__item">${ACCESS.hearing}청각</span>
          <span class="sign__item">${ACCESS.child}유아 동반</span>
          <span class="sign__item">${ACCESS.elderly}고령자</span>
          <a class="sign__go" href="#download">${ARROW}모두 함께</a>
        </nav>
      </div>

      <figure class="mock" role="img" aria-label="모두와 앱 화면 예시. 홈 화면에서 휠체어로 이동하기 좋은 코스를 추천하고, 플랜 화면에 부모님과 함께하는 경주 여행과 아이와 함께하는 제주 여행이 있어요.">
        <div class="phone phone--back" aria-hidden="true">
          <div class="phone__screen s">
            <span class="island"></span>
            <div class="s-status"><span>9:41</span><i><b></b><b></b></i></div>
            <div class="s-title"><h4>플랜</h4>${TICKET}</div>
            <div class="s-plans">
              <div class="s-plan" style="background-image:url('${assetUrl('cover_gyeongju.jpg')}')">
                <span class="badge">${ACCESS.elderly}고령자 친화</span>
                <div class="txt"><b>부모님과 함께하는 경주 여행</b><small>10.17 – 10.19 · 2박 3일</small></div>
              </div>
              <div class="s-plan" style="background-image:url('${assetUrl('cover_jeju.jpg')}')">
                <span class="badge">${ACCESS.child}유아 동반</span>
                <div class="txt"><b>아이와 함께하는 제주 여행</b><small>11.07 – 11.10 · 3박 4일</small></div>
              </div>
            </div>
            <div class="s-new">+ 새 플랜 만들기</div>
          </div>
        </div>

        <div class="phone phone--front" aria-hidden="true">
          <div class="phone__screen s">
            <span class="island"></span>
            <div class="s-status"><span>9:41</span><i><b></b><b></b></i></div>
            <div class="s-head">
              <span class="logo">${LOGO}</span>
              <span class="acts">${UI.search}${UI.bell}</span>
            </div>
            <div class="s-body">
              <div class="s-hero">
                <span class="k">${ACCESS.wheelchair}맞춤 접근성 추천</span>
                <p class="t">모두와 님,<br>휠체어로 이동하기 좋은 코스를 추천드려요</p>
                <div class="s-chips"><span>#휠체어접근</span><span>#고령자친화</span></div>
                <span class="s-cta">추천 여행 코스 보러가기${CHEV}</span>
              </div>
              <div class="s-sec">
                <h4>내 일정에 어울리는 추천 맛집·장소</h4>
                <p>온보딩 정보를 바탕으로 골라봤어요</p>
                <div class="s-cats"><span class="on">관광지</span><span>숙박</span><span>음식점</span><span>축제</span></div>
                <div class="s-cards">
                  <div class="s-card"><span class="ph">${CATEGORY.attraction}</span><b>강릉 녹색도시체험센터</b><small>강원 강릉시</small>
                    <span class="ac">${ACCESS.wheelchair}휠체어 대여</span></div>
                  <div class="s-card"><span class="ph">${CATEGORY.stay}</span><b>롯데시티호텔 마포</b><small>서울 마포구</small>
                    <span class="ac">${ACCESS.wheelchair}휠체어 대여가능</span></div>
                </div>
              </div>
            </div>
            <div class="s-tabs">
              <span class="on">${TAB.home}홈</span><span>${TAB.plan}플랜</span><span>${TAB.schedule}일정</span><span>${TAB.saved}저장</span>
            </div>
          </div>
        </div>
        <figcaption class="mock__cap">앱 화면 예시</figcaption>
      </figure>
    </div>
  </div>
</section>

<footer class="foot">
  <nav aria-label="약관 및 지원">
    <a href="/privacy"><b>개인정보 처리방침</b></a>
    <a href="/terms">이용약관</a>
    <a href="/support">고객 지원</a>
    <a href="/delete-account">계정 삭제 요청</a>
  </nav>
  <p>장소·무장애 정보 출처: 한국관광공사 TourAPI (data.go.kr)</p>
</footer>
</body>
</html>`;
}

// ── 스타일 ── design-system.md 토큰 + Hero 레이아웃
const STYLE = `
/* design-system.md 의 CSS 변수 — 그대로 옮겼다(바꾸지 않는다) */
:root {
  /* Primary */
  --color-primary: #A7E100;
  --color-primary-dark: #075B39;
  --color-primary-text-on-cta: #0B2A1C;

  /* Background */
  --color-bg: #FFFFFF;
  --gradient-bg: linear-gradient(180deg, #CAF354 11%, #FFFFFF 29%);

  /* Gray scale */
  --color-text-strong: #4D4D4D;
  --color-border: #B3B3B3;
  --color-bg-light: #E6E6E6;
  --color-bg-lightest: #F2F2F2;

  /* Typography */
  --font-family: 'Pretendard', sans-serif;
  --font-title: 700 28px/1.3 var(--font-family);
  --font-heading: 600 22px/1.3 var(--font-family);
  --font-subtitle: 500 17px/1.4 var(--font-family);
  --font-body: 400 15px/1.5 var(--font-family);
  --font-caption: 400 13px/1.4 var(--font-family);
  --font-minimal: 500 11px/1.3 var(--font-family);
}

/* ── 레이아웃에만 쓰는 값(색 아님) — Hero 와 푸터가 같은 여백을 쓴다 ── */
body {
  --gutter: clamp(16px, 5vw, 56px);
  --max: 1200px;
  --radius-lg: 20px;
  --radius-pill: 999px;
  --focus: 3px solid var(--color-primary-dark);
}

*, *::before, *::after { box-sizing: border-box; }
html { color-scheme: light; -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--color-bg);
  color: var(--color-text-strong);
  font: var(--font-body);
  word-break: keep-all;
  overflow-wrap: break-word;
  -webkit-font-smoothing: antialiased;
}
img, svg { display: block; max-width: 100%; }
p, h1, h2, h3, ul, ol, figure { margin: 0; padding: 0; }
ul, ol { list-style: none; }
a { color: inherit; }
:focus-visible { outline: var(--focus); outline-offset: 3px; border-radius: 8px; }

.sr-only {
  position: absolute; width: 1px; height: 1px; overflow: hidden;
  clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap;
}
.skip {
  position: absolute; left: 12px; top: -80px; z-index: 10;
  background: var(--color-primary-text-on-cta); color: var(--color-bg);
  font: var(--font-subtitle); padding: 10px 16px; border-radius: 10px; text-decoration: none;
}
.skip:focus { top: 12px; }

/* ═════════════════ HERO ═════════════════ */
.hero {
  background: var(--gradient-bg);
  /* 그라데이션은 뷰포트가 아니라 섹션 높이 기준으로 11% → 29% 에서 끝난다(앱 홈과 같은 비율). */
  padding-inline: var(--gutter);
  padding-bottom: clamp(48px, 7vw, 96px);
  overflow: hidden;
}
.hero__inner { max-width: var(--max); margin-inline: auto; }

/* 상단 바 */
.topbar {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  min-height: 72px;
}
.topbar__logo { color: var(--color-primary-text-on-cta); display: inline-flex; }
.topbar__logo svg { height: 32px; width: auto; }
.topbar__cta {
  font: var(--font-subtitle); font-weight: 600;
  color: var(--color-primary-text-on-cta); text-decoration: none;
  padding: 10px 18px; border-radius: var(--radius-pill);
  background: var(--color-bg);
  box-shadow: 0 0 0 1.5px var(--color-primary-text-on-cta) inset;
  min-height: 44px; display: inline-flex; align-items: center;
}
.topbar__cta:hover { background: var(--color-bg-lightest); }

/* 본문 그리드 */
.hero__grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: clamp(40px, 6vw, 80px);
  align-items: center;
  padding-top: clamp(32px, 6vw, 72px);
}

/* 왼쪽: 카피 */
.hero__copy { display: grid; gap: 24px; justify-items: start; }

/* 안내표지 모양의 라벨 — 공항 웨이파인딩 사인의 "픽토그램 + 한 단어" */
.tag {
  display: inline-flex; align-items: center; gap: 10px;
  font: var(--font-subtitle); font-weight: 600;
  color: var(--color-bg);
  background: var(--color-primary-dark);
  padding: 8px 16px 8px 8px;
  border-radius: 10px;
}
.tag__pict {
  width: 32px; height: 32px; border-radius: 6px;
  background: var(--color-primary); color: var(--color-primary-text-on-cta);
  display: grid; place-items: center;
}
.tag__pict svg { height: 20px; width: auto; }

.hero__title {
  font: var(--font-title);
  color: var(--color-primary-text-on-cta);
  letter-spacing: -0.02em;
  text-wrap: balance;
}
.hero__title em {
  font-style: normal;
  /* 라임 형광펜 — 글자 밑 40% 만 칠해 글자 대비(#0B2A1C on #FFF)를 해치지 않는다 */
  background: linear-gradient(transparent 60%, var(--color-primary) 60%);
  padding-inline: 0.04em;
}
.hero__lede {
  font: var(--font-subtitle);
  font-weight: 400;
  line-height: 1.65;
  color: var(--color-text-strong);
  max-width: 30em;
}
.hero__lede strong { font-weight: 600; color: var(--color-primary-text-on-cta); }

/* 스토어 버튼 */
.stores { display: flex; flex-wrap: wrap; gap: 12px; }
.store {
  display: inline-flex; align-items: center; gap: 12px;
  min-height: 60px; padding: 10px 24px 10px 18px;
  border-radius: 14px; text-decoration: none;
}
.store svg { width: 26px; height: 26px; flex: none; }
.store__txt { display: grid; gap: 2px; }
.store__txt small { font: var(--font-minimal); }
.store__txt b { font: var(--font-subtitle); font-weight: 700; }
.store--live {
  background: var(--color-primary);
  color: var(--color-primary-text-on-cta);           /* 9.8:1 — design-system.md */
  box-shadow: 0 6px 16px -6px var(--color-primary-dark);
  transition: transform .15s ease, box-shadow .15s ease;
}
.store--live:hover { transform: translateY(-1px); box-shadow: 0 10px 20px -8px var(--color-primary-dark); }
.store--live:active { transform: translateY(0); }
.store--soon {
  color: var(--color-text-strong);
  background: var(--color-bg);
  border: 1.5px dashed var(--color-border);
}

.facts { display: flex; flex-wrap: wrap; gap: 6px 18px; font: var(--font-caption); color: var(--color-text-strong); }
.facts li { display: inline-flex; align-items: center; gap: 6px; }
.facts li::before {
  content: ""; width: 14px; height: 14px; flex: none; border-radius: 50%;
  background: var(--color-primary-dark)
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Cpath d='M4 7.2l2 2 4-4.4' fill='none' stroke='%23fff' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center/100% no-repeat;
}

/* ── 안내표지판 ── 공항·병원 사이니지처럼 픽토그램을 크게, 글자는 짧게 */
.sign {
  width: 100%;
  margin-top: 8px;
  background: var(--color-primary-dark);
  color: var(--color-bg);
  border-radius: 14px;
  padding: 14px;
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr)) auto;
  gap: 8px;
  align-items: stretch;
}
.sign__item {
  display: grid; justify-items: center; align-content: center; gap: 6px;
  padding: 10px 4px;
  border-radius: 8px;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-bg) 22%, transparent) inset;
  font: var(--font-caption); font-weight: 500; text-align: center;
}
.sign__item svg { height: 28px; width: auto; color: var(--color-bg); }
.sign__go {
  display: grid; place-items: center; gap: 4px;
  background: var(--color-primary); color: var(--color-primary-text-on-cta);
  border-radius: 8px; padding: 10px 14px;
  font: var(--font-caption); font-weight: 700; white-space: nowrap;
}
.sign__go svg { width: 26px; height: 26px; }

/* ═════════ 오른쪽: 앱 화면 목업 ═════════ */
.mock {
  position: relative;
  justify-self: center;
  width: min(100%, 520px);
  aspect-ratio: 520 / 690;
  margin-bottom: 28px;
}
.phone {
  position: absolute;
  width: 58%;
  aspect-ratio: 300 / 624;
  border-radius: 13% / 6.25%;
  padding: 2.4%;
  background: var(--color-primary-text-on-cta);
  box-shadow:
    0 1px 0 1px color-mix(in srgb, var(--color-bg) 18%, transparent) inset,
    0 30px 60px -24px color-mix(in srgb, var(--color-primary-text-on-cta) 55%, transparent),
    0 12px 24px -12px color-mix(in srgb, var(--color-primary-text-on-cta) 35%, transparent);
}
/* 뒤 폰은 왼쪽 — 플랜 카드 제목이 왼쪽 정렬이라 앞 폰에 가려지지 않는다 */
.phone--front { right: 0; top: 0; z-index: 2; }
.phone--back  { left: 0; top: 9%; z-index: 1; transform: rotate(-4deg); transform-origin: 70% 80%; }
.phone__screen {
  position: relative; width: 100%; height: 100%;
  border-radius: 11% / 5.4%;
  overflow: hidden;
  background: var(--gradient-bg);
  /* 화면 안의 크기는 목업 폭을 기준으로 줄어든다 — 컨테이너 쿼리 단위 */
  container-type: inline-size;
  display: flex; flex-direction: column;
}
.phone--back .phone__screen { background: var(--color-bg); }
.island {
  position: absolute; top: 2.2cqw; left: 50%; transform: translateX(-50%);
  width: 30cqw; height: 8.5cqw; border-radius: 99px; background: var(--color-primary-text-on-cta); z-index: 3;
}

/* 화면 안 — 앱 치수(393pt 폭)를 cqw 로 환산: 1pt ≈ 0.254cqw */
.s { font-family: var(--font-family); color: var(--color-primary-text-on-cta); }
.s-status {
  display: flex; justify-content: space-between; align-items: center;
  padding: 4cqw 7.5cqw 0; height: 12.5cqw;
  font-size: 4cqw; font-weight: 600;
}
.s-status i { display: flex; gap: 1.2cqw; align-items: center; }
.s-status i b { display: block; width: 5.5cqw; height: 2.8cqw; border-radius: 1cqw; background: currentColor; }
.s-status i b:first-child { width: 4cqw; height: 3.2cqw; border-radius: .5cqw; clip-path: polygon(0 100%, 100% 0, 100% 100%); }
.s-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 2cqw 5.2cqw 3cqw;
}
.s-head .logo svg { height: 7.6cqw; width: auto; }
.s-head .acts { display: flex; gap: 3.2cqw; }
.s-head .acts svg { width: 6.4cqw; height: 6.4cqw; }
.s-body { flex: 1; overflow: hidden; padding: 0 5.2cqw; display: grid; gap: 5cqw; align-content: start; }

.s-hero {
  background: var(--color-bg); border-radius: 5.1cqw; padding: 5.1cqw;
  display: grid; gap: 3.6cqw;
  box-shadow: 0 .5cqw 2.5cqw color-mix(in srgb, var(--color-primary-dark) 8%, transparent);
}
.s-hero .k { display: flex; align-items: center; gap: 1.3cqw; color: var(--color-primary-dark); font-size: 3.8cqw; font-weight: 700; }
.s-hero .k svg { height: 4cqw; width: auto; }
.s-hero .t { font-size: 6.1cqw; font-weight: 700; line-height: 1.42; letter-spacing: -.02em; }
.s-chips { display: flex; flex-wrap: wrap; gap: 1.6cqw; }
.s-chips span {
  font-size: 3.4cqw; font-weight: 500; color: var(--color-primary-dark);
  background: var(--color-bg-lightest); padding: 1.2cqw 2.8cqw; border-radius: 99px;
}
.s-cta {
  height: 12.2cqw; border-radius: 99px; background: var(--color-primary);
  display: flex; align-items: center; justify-content: center; gap: 1cqw;
  font-size: 4.1cqw; font-weight: 700;
  box-shadow: 0 1cqw 1.8cqw color-mix(in srgb, var(--color-primary) 45%, transparent);
}
.s-cta svg { width: 3.6cqw; height: 3.6cqw; }

.s-sec h4 { margin: 0; font-size: 5.1cqw; font-weight: 700; letter-spacing: -.02em; }
.s-sec p { font-size: 3.3cqw; color: var(--color-text-strong); margin-top: .6cqw; }
.s-cats { display: flex; gap: 1.6cqw; margin-top: 3.2cqw; }
.s-cats span {
  font-size: 3.4cqw; font-weight: 500; padding: 1.4cqw 3.2cqw; border-radius: 99px;
  border: .3cqw solid var(--color-bg-light); color: var(--color-text-strong); background: var(--color-bg);
}
.s-cats span.on { background: var(--color-primary-text-on-cta); color: var(--color-bg); border-color: transparent; }
.s-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 3cqw; margin-top: 3.4cqw; }
.s-card { display: grid; gap: 1.2cqw; }
.s-card .ph {
  aspect-ratio: 1 / 1; border-radius: 3.6cqw; background: var(--color-bg-light);
  display: grid; place-items: center; color: var(--color-bg);
}
.s-card .ph svg { width: 11cqw; height: 11cqw; }
.s-card b { font-size: 3.7cqw; font-weight: 700; line-height: 1.3; }
.s-card small { font-size: 3cqw; color: var(--color-text-strong); }
.s-card .ac { display: flex; gap: 1cqw; align-items: center; font-size: 3cqw; font-weight: 500; color: var(--color-primary-dark); }
.s-card .ac svg { height: 3.2cqw; width: auto; flex: none; }

.s-tabs {
  display: grid; grid-template-columns: repeat(4, 1fr);
  background: var(--color-bg); border-top: .3cqw solid var(--color-bg-light);
  padding: 2.6cqw 2cqw 7cqw;
}
.s-tabs span { display: grid; justify-items: center; gap: 1cqw; font-size: 2.8cqw; font-weight: 500; color: var(--color-border); }
.s-tabs span svg { width: 6cqw; height: 6cqw; }
.s-tabs span.on { color: var(--color-primary-text-on-cta); }

/* 뒤 폰 — 플랜 목록 */
.s-title { display: flex; justify-content: space-between; align-items: center; padding: 2cqw 5.2cqw 4cqw; }
.s-title h4 { margin: 0; font-size: 6.6cqw; font-weight: 700; }
.s-title svg { width: 6.4cqw; height: 6.4cqw; }
.s-plans { display: grid; gap: 3.6cqw; padding: 0 5.2cqw; }
.s-plan {
  position: relative; aspect-ratio: 340 / 200; border-radius: 4.6cqw; overflow: hidden;
  background: var(--color-bg-light) center / cover no-repeat;
}
.s-plan::after {
  content: ""; position: absolute; inset: 0;
  background: linear-gradient(to top, color-mix(in srgb, var(--color-primary-text-on-cta) 78%, transparent) 0%, transparent 62%);
}
.s-plan .txt { position: absolute; left: 4.4cqw; right: 4.4cqw; bottom: 3.8cqw; z-index: 1; color: var(--color-bg); }
.s-plan .txt b { display: block; font-size: 4.6cqw; font-weight: 700; letter-spacing: -.02em; }
.s-plan .txt small { font-size: 3.2cqw; opacity: .9; }
.s-plan .badge {
  position: absolute; top: 3.4cqw; left: 3.4cqw; z-index: 1;
  display: flex; align-items: center; gap: 1cqw;
  background: var(--color-primary); color: var(--color-primary-text-on-cta);
  font-size: 2.9cqw; font-weight: 700; padding: 1cqw 2.4cqw; border-radius: 99px;
}
.s-plan .badge svg { height: 3.2cqw; width: auto; }
.s-new {
  margin: 4cqw 5.2cqw 0; height: 12.2cqw; border-radius: 99px;
  border: .4cqw dashed var(--color-border); display: flex; align-items: center; justify-content: center;
  font-size: 3.8cqw; font-weight: 600; color: var(--color-text-strong);
}

.mock__cap {
  position: absolute; right: 0; bottom: -28px; z-index: 3;
  font: var(--font-minimal); color: var(--color-text-strong);
  background: var(--color-bg); padding: 4px 10px; border-radius: 99px;
  box-shadow: 0 0 0 1px var(--color-bg-light) inset;
}

/* ═════════ 반응형 ═════════ */
@media (min-width: 640px) {
  .hero__title { font-size: 44px; line-height: 1.25; }
}
@media (min-width: 1024px) {
  .hero__title { font-size: 58px; line-height: 1.2; }
}
@media (max-width: 959px) {
  .hero__grid { grid-template-columns: minmax(0, 1fr); }
  .mock { width: min(100%, 460px); }
}
@media (max-width: 560px) {
  .topbar { min-height: 60px; }
  .topbar__logo svg { height: 26px; }
  .topbar__cta { font: var(--font-caption); font-weight: 600; padding: 8px 14px; }
  .store { flex: 1 1 100%; justify-content: center; }
  .sign { grid-template-columns: repeat(5, minmax(0, 1fr)); padding: 10px; gap: 6px; }
  .sign__item { padding: 8px 2px; font: var(--font-minimal); }
  .sign__item svg { height: 24px; }
  .sign__go { grid-column: 1 / -1; grid-auto-flow: column; justify-content: center; gap: 8px; font: var(--font-caption); font-weight: 700; }
  .sign__go svg { width: 20px; height: 20px; }
  .mock { aspect-ratio: 520 / 760; }
  .phone { width: 64%; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; }
}
/* 고대비 요청 — 점선·보더를 짙게 */
@media (prefers-contrast: more) {
  .store--soon { border-color: var(--color-text-strong); }
  .sign__item { box-shadow: 0 0 0 1.5px var(--color-bg) inset; }
}

/* 푸터 — 처리방침 링크는 루트에서 닿아야 한다(구글 OAuth 동의 화면 검증이 홈페이지의 처리방침 링크를 본다) */
.foot {
  padding: 24px 0 40px;
  margin-inline: max(var(--gutter), (100% - var(--max)) / 2);
  display: flex; flex-wrap: wrap; gap: 8px 24px; justify-content: space-between;
  font: var(--font-caption); color: var(--color-text-strong);
  border-top: 1px solid var(--color-bg-light);
}
.foot nav { display: flex; flex-wrap: wrap; gap: 4px 16px; }
.foot a { color: var(--color-primary-text-on-cta); text-decoration: none; }
.foot a:hover { text-decoration: underline; }
.foot b { font-weight: 600; }
`;
