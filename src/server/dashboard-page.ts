// 대시보드 HTML — 빌드 도구 없이 서버가 문자열로 뱉는 단일 페이지.
// 외부 CDN 을 쓰지 않는다(오프라인·CSP 안전, 의존성 0). 클라이언트 스크립트에는
// 템플릿 리터럴을 쓰지 않는다 — 이 파일 자체가 템플릿 리터럴이라 이스케이프가 지저분해진다.

const STYLE = `
:root {
  --bg: #f6f7f9; --panel: #fff; --line: #e3e6ea; --fg: #1b1f24; --muted: #6b7280;
  --accent: #2563eb; --good: #16a34a; --warn: #d97706; --bad: #dc2626; --code: #f3f4f6;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1216; --panel: #171b21; --line: #262c34; --fg: #e6e9ee; --muted: #97a1af;
    --accent: #60a5fa; --good: #4ade80; --warn: #fbbf24; --bad: #f87171; --code: #11151a;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg); font-size: 14px;
  font-family: -apple-system, BlinkMacSystemFont, "Pretendard", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
}
a { color: var(--accent); }
header {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 14px 20px; background: var(--panel); border-bottom: 1px solid var(--line);
  position: sticky; top: 0; z-index: 10;
}
header h1 { font-size: 15px; margin: 0; font-weight: 700; letter-spacing: -0.01em; }
header .meta { color: var(--muted); font-size: 12px; }
header .spacer { flex: 1; }
.tabs { display: flex; gap: 4px; }
.tab {
  padding: 6px 12px; border-radius: 7px; border: 1px solid transparent;
  background: none; color: var(--muted); cursor: pointer; font: inherit; font-size: 13px;
}
.tab:hover { color: var(--fg); }
.tab.on { background: var(--bg); border-color: var(--line); color: var(--fg); font-weight: 600; }
button.act {
  padding: 6px 12px; border-radius: 7px; border: 1px solid var(--line);
  background: var(--panel); color: var(--fg); cursor: pointer; font: inherit; font-size: 13px;
}
button.act:hover { border-color: var(--accent); color: var(--accent); }
button.act[disabled] { opacity: .5; cursor: default; }
main { padding: 20px; max-width: 1400px; margin: 0 auto; }
section { display: none; }
section.on { display: block; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; margin-bottom: 22px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 11px; padding: 14px 16px; }
.card .k { color: var(--muted); font-size: 12px; margin-bottom: 6px; }
.card .v { font-size: 25px; font-weight: 700; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.card .s { color: var(--muted); font-size: 12px; margin-top: 4px; }
.card .s b { color: var(--accent); font-weight: 600; }
/* ── 신고 운영(049) ── */
.badge {
  display: inline-block; min-width: 18px; margin-left: 6px; padding: 1px 6px;
  border-radius: 9px; background: var(--bad); color: #fff; font-size: 11px; font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.badge:empty { display: none; }
.rep { background: var(--panel); border: 1px solid var(--line); border-radius: 11px;
       padding: 14px 16px; margin-bottom: 10px; }
.rep.done { opacity: .62; }
.rep .top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.rep .cnt { font-weight: 700; font-size: 15px; font-variant-numeric: tabular-nums; }
.rep .cnt.hot { color: var(--bad); }
.rep .who { color: var(--muted); font-size: 12px; }
.rep .spacer { flex: 1; }
.tag { padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line);
       font-size: 11px; color: var(--muted); background: var(--bg); white-space: nowrap; }
.tag.reason { border-color: var(--warn); color: var(--warn); }
.tag.gone { border-color: var(--bad); color: var(--bad); }
.rep .body {
  background: var(--code); border-radius: 8px; padding: 10px 12px; margin: 8px 0;
  white-space: pre-wrap; word-break: break-word; max-height: 180px; overflow: auto;
  font-size: 13px; line-height: 1.55;
}
.rep .body.none { color: var(--muted); font-style: italic; }
.rep .note { color: var(--good); font-size: 12px; margin-top: 6px; }
.rep .acts { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
.rep .acts input { flex: 1; min-width: 180px; padding: 6px 10px; border-radius: 7px;
  border: 1px solid var(--line); background: var(--bg); color: var(--fg); font: inherit; font-size: 13px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 26px 0 10px; }
h2:first-child { margin-top: 0; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 11px; overflow: hidden; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { font-size: 12px; color: var(--muted); font-weight: 600; background: var(--bg); position: sticky; top: 0; }
tbody tr:last-child td { border-bottom: none; }
tbody tr:hover { background: var(--bg); }
td.num, th.num { text-align: right; }
td.dim { color: var(--muted); }
.bar { height: 6px; border-radius: 3px; background: var(--line); overflow: hidden; min-width: 90px; }
.bar > i { display: block; height: 100%; background: var(--accent); }
.cov { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(310px, 1fr)); }
.cov .item { background: var(--panel); border: 1px solid var(--line); border-radius: 11px; padding: 14px 16px; }
.cov .top { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; margin-bottom: 4px; }
.cov .lbl { font-weight: 600; }
.cov .pct { font-size: 17px; font-weight: 700; font-variant-numeric: tabular-nums; }
.cov .note { color: var(--muted); font-size: 12px; margin: 6px 0 9px; }
.cov .cnt { color: var(--muted); font-size: 12px; margin-top: 6px; font-variant-numeric: tabular-nums; }
.pill { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; border: 1px solid var(--line); color: var(--muted); }
.pill.good { color: var(--good); border-color: var(--good); }
.pill.warn { color: var(--warn); border-color: var(--warn); }
.note { color: var(--muted); font-size: 12px; margin: 8px 2px; }
.err { color: var(--bad); font-size: 13px; margin: 10px 2px; white-space: pre-wrap; }
textarea {
  width: 100%; min-height: 130px; padding: 12px; border-radius: 10px; resize: vertical;
  border: 1px solid var(--line); background: var(--code); color: var(--fg);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; line-height: 1.5;
}
select, input[type=text] {
  padding: 6px 10px; border-radius: 7px; border: 1px solid var(--line);
  background: var(--panel); color: var(--fg); font: inherit; font-size: 13px;
}
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 10px 0; }
.hint { color: var(--muted); font-size: 12px; }
code { background: var(--code); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
.cellnull { color: var(--muted); font-style: italic; }
.loading { color: var(--muted); padding: 16px; }
`;

const LOGIN_STYLE = `
body { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
form {
  background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
  padding: 28px; width: 320px; max-width: calc(100vw - 32px);
}
form h1 { font-size: 17px; margin: 0 0 4px; }
form p { color: var(--muted); font-size: 12px; margin: 0 0 18px; }
form input {
  width: 100%; padding: 10px 12px; border-radius: 9px; border: 1px solid var(--line);
  background: var(--bg); color: var(--fg); font: inherit; margin-bottom: 10px;
}
form button {
  width: 100%; padding: 10px; border-radius: 9px; border: none; cursor: pointer;
  background: var(--accent); color: #fff; font: inherit; font-weight: 600;
}
form .err { margin: 0 0 10px; }
`;

export function loginPage(error?: string): string {
  return `<!doctype html>
<html lang="ko"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>moduwa 수집 대시보드 — 로그인</title>
<style>${STYLE}${LOGIN_STYLE}</style>
</head><body>
<form method="post" action="/dashboard/login">
  <h1>moduwa 수집 대시보드</h1>
  <p>비밀번호를 입력하세요.</p>
  ${error ? `<div class="err">${error}</div>` : ''}
  <input type="password" name="password" placeholder="비밀번호" autofocus autocomplete="current-password" required>
  <button type="submit">로그인</button>
</form>
</body></html>`;
}

export function disabledPage(): string {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>대시보드 비활성</title><style>${STYLE}</style></head>
<body><main><h2>대시보드가 비활성 상태입니다</h2>
<p class="note">환경변수 <code>DASHBOARD_PASSWORD</code> 를 설정한 뒤 서버를 재시작하세요.
비밀번호가 없으면 라우트를 열지 않습니다.</p></main></body></html>`;
}

export function dashboardPage(): string {
  return `<!doctype html>
<html lang="ko"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>moduwa 수집 대시보드</title>
<style>${STYLE}</style>
</head><body>
<header>
  <h1>moduwa 수집 대시보드</h1>
  <span class="meta" id="dbmeta"></span>
  <div class="spacer"></div>
  <div class="tabs">
    <button class="tab on" data-tab="overview">개요</button>
    <button class="tab" data-tab="tables">테이블</button>
    <button class="tab" data-tab="reports">신고<span class="badge" id="rbadge"></span></button>
    <button class="tab" data-tab="sql">SQL</button>
  </div>
  <button class="act" id="refresh">새로고침</button>
  <form method="post" action="/dashboard/logout" style="margin:0"><button class="act" type="submit">로그아웃</button></form>
</header>
<main>
  <section id="overview" class="on"><div class="loading">불러오는 중…</div></section>
  <section id="tables">
    <div class="row">
      <select id="tsel"></select>
      <button class="act" id="tprev">◀ 이전</button>
      <button class="act" id="tnext">다음 ▶</button>
      <span class="hint" id="tinfo"></span>
    </div>
    <div class="panel scroll" id="tbody"></div>
  </section>
  <section id="reports">
    <div class="row">
      <select id="ropen">
        <option value="open">볼 것만 (미처리)</option>
        <option value="all">전체</option>
      </select>
      <select id="rtype">
        <option value="">모든 대상</option>
        <option value="post">게시글</option>
        <option value="post_comment">게시글 댓글</option>
        <option value="review">후기</option>
        <option value="review_comment">후기 댓글</option>
      </select>
      <select id="rreason">
        <option value="">모든 사유</option>
        <option value="spam">spam</option>
        <option value="abuse">abuse</option>
        <option value="falseInfo">falseInfo</option>
        <option value="privacyLeak">privacyLeak</option>
        <option value="irrelevant">irrelevant</option>
        <option value="other">other</option>
      </select>
      <span class="hint" id="rinfo"></span>
    </div>
    <div id="rlist"><div class="loading">불러오는 중…</div></div>
  </section>
  <section id="sql">
    <textarea id="q" spellcheck="false" placeholder="select ... 또는 with ... — 읽기 전용, 한 문장만"></textarea>
    <div class="row">
      <button class="act" id="run">실행 (⌘/Ctrl+Enter)</button>
      <select id="samples"><option value="">예시 쿼리…</option></select>
      <span class="hint" id="qinfo"></span>
    </div>
    <div class="err" id="qerr"></div>
    <div class="panel scroll" id="qout"></div>
  </section>
</main>
<script>${CLIENT_JS}</script>
</body></html>`;
}

// 클라이언트 스크립트 — 템플릿 리터럴 없이 문자열 결합만 사용한다.
const CLIENT_JS = `
var fmt = function (n) { return n == null ? '—' : Number(n).toLocaleString('ko-KR'); };
var pct = function (a, b) { return b > 0 ? (a / b * 100) : 0; };
var pctStr = function (v) { return (v >= 10 ? v.toFixed(1) : v.toFixed(2)) + '%'; };
var esc = function (s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
};
var size = function (b) {
  if (!b) return '—';
  var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0, v = Number(b);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + u[i];
};
var ago = function (iso) {
  if (!iso) return '—';
  var d = new Date(iso), m = Math.floor((Date.now() - d.getTime()) / 60000);
  if (m < 1) return '방금';
  if (m < 60) return m + '분 전';
  if (m < 1440) return Math.floor(m / 60) + '시간 전';
  return Math.floor(m / 1440) + '일 전';
};
var bar = function (v) {
  return '<div class="bar"><i style="width:' + Math.min(100, Math.max(0, v)).toFixed(2) + '%"></i></div>';
};
var cell = function (v) {
  if (v === null || v === undefined) return '<span class="cellnull">null</span>';
  if (typeof v === 'object') { var s = JSON.stringify(v); return esc(s.length > 200 ? s.slice(0, 200) + '…' : s); }
  var t = String(v);
  return esc(t.length > 200 ? t.slice(0, 200) + '…' : t);
};

var api = function (path, opts) {
  return fetch('/dashboard/api' + path, opts || {}).then(function (r) {
    if (r.status === 401) { location.href = '/dashboard/login'; throw new Error('세션 만료'); }
    return r.json().then(function (j) {
      if (!r.ok) throw new Error(j.message || j.error || ('HTTP ' + r.status));
      return j;
    });
  });
};

// ── 탭 ──
var tabs = document.querySelectorAll('.tab');
for (var i = 0; i < tabs.length; i++) {
  tabs[i].addEventListener('click', function (e) {
    // ⚠️ e.target 이 아니라 closest 다 — 탭 안에 배지(span)가 있어서, 배지를 누르면
    //    e.target 이 span 이 되어 data-tab 이 null 이 되고 탭이 열리지 않는다.
    var btn = e.target.closest('.tab');
    if (!btn) return;
    var name = btn.getAttribute('data-tab');
    document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('on', t === btn); });
    document.querySelectorAll('section').forEach(function (s) { s.classList.toggle('on', s.id === name); });
    if (name === 'tables' && !window.__tablesReady) loadTableList();
    if (name === 'reports') loadReports();
  });
}

// ── 신고 운영(049) ──
//  이 화면의 핵심은 "무엇이 신고됐는지" 를 그 자리에서 보여주는 것이다. 서버가 본문·작성자를
//  조인해 주므로 여기서는 그리기만 한다.
var TYPE_LABEL = {
  post: '게시글', post_comment: '게시글 댓글', review: '후기', review_comment: '후기 댓글'
};

function loadReports() {
  var open = document.getElementById('ropen').value;
  var type = document.getElementById('rtype').value;
  var reason = document.getElementById('rreason').value;
  var q = '/reports?open=' + encodeURIComponent(open)
        + (type ? '&targetType=' + encodeURIComponent(type) : '')
        + (reason ? '&reason=' + encodeURIComponent(reason) : '');
  document.getElementById('rlist').innerHTML = '<div class="loading">불러오는 중…</div>';
  api(q).then(renderReports).catch(function (e) {
    document.getElementById('rlist').innerHTML = '<div class="err">' + esc(e.message) + '</div>';
  });
}

function renderReports(d) {
  var badge = document.getElementById('rbadge');
  badge.textContent = d.counts.open > 0 ? String(d.counts.open) : '';
  var byReason = d.counts.byReason.map(function (r) { return r.reason + ' ' + r.n; }).join(' · ');
  document.getElementById('rinfo').textContent =
    '미처리 ' + fmt(d.counts.open) + ' / 전체 ' + fmt(d.counts.total)
    + (byReason ? ' — ' + byReason : '');

  if (!d.groups.length) {
    document.getElementById('rlist').innerHTML =
      '<div class="panel" style="padding:22px;text-align:center;color:var(--muted)">신고가 없습니다.</div>';
    return;
  }
  var h = '';
  for (var i = 0; i < d.groups.length; i++) {
    var g = d.groups[i];
    var done = g.openCount === 0;
    h += '<div class="rep' + (done ? ' done' : '') + '">';
    h += '<div class="top">';
    h += '<span class="cnt' + (g.reports >= 3 ? ' hot' : '') + '">신고 ' + g.reports + '</span>';
    h += '<span class="tag">' + esc(TYPE_LABEL[g.targetType] || g.targetType) + '</span>';
    for (var j = 0; j < g.reasons.length; j++) {
      h += '<span class="tag reason">' + esc(g.reasons[j]) + '</span>';
    }
    if (g.targetGone) h += '<span class="tag gone">이미 삭제됨</span>';
    if (g.authorDeleted) h += '<span class="tag gone">탈퇴한 작성자</span>';
    h += '<span class="spacer"></span>';
    h += '<span class="who">' + ago(g.lastAt) + '</span>';
    h += '</div>';

    h += '<div class="who">작성자 ' + esc(g.authorNickname || '(알 수 없음)')
       + (g.authorUuid ? ' · <code>' + esc(g.authorUuid.slice(0, 8)) + '</code>' : '')
       + ' · 신고자 ' + esc(g.reporters.join(', ')) + '</div>';

    if (g.body) {
      h += '<div class="body">' + esc(g.body) + '</div>';
    } else {
      h += '<div class="body none">대상이 지워져 내용을 볼 수 없습니다. (' + esc(g.targetId) + ')</div>';
    }
    for (var k = 0; k < g.notes.length; k++) {
      h += '<div class="note">✓ ' + esc(g.notes[k]) + '</div>';
    }

    var key = esc(g.targetType) + '|' + esc(g.targetId);
    h += '<div class="acts" data-key="' + key + '">';
    if (done) {
      h += '<button class="act" data-do="reopen">다시 볼 것으로</button>';
    } else {
      h += '<input placeholder="판단 내용 (예: 조치함 / 문제 없음)" data-note>';
      h += '<button class="act" data-do="ok">문제 없음</button>';
      h += '<button class="act" data-do="acted">조치함</button>';
    }
    h += '</div></div>';
  }
  document.getElementById('rlist').innerHTML = h;
}

// 버튼은 위임으로 받는다 — 목록을 다시 그릴 때마다 리스너를 붙이지 않게.
document.getElementById('rlist').addEventListener('click', function (e) {
  var btn = e.target.closest('button[data-do]');
  if (!btn) return;
  var acts = btn.parentNode;
  var parts = acts.getAttribute('data-key').split('|');
  var input = acts.querySelector('[data-note]');
  var typed = input ? input.value.trim() : '';
  var note = btn.getAttribute('data-do') === 'reopen' ? ''
    : (typed || (btn.getAttribute('data-do') === 'ok' ? '문제 없음' : '조치함'));
  btn.disabled = true;
  api('/reports/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetType: parts[0], targetId: parts[1], note: note })
  }).then(loadReports).catch(function (err) { btn.disabled = false; alert(err.message); });
});

// 첫 진입에서 탭 배지에 미처리 수가 바로 보이게 한 번 읽는다 — 신고 탭을 열어야만
//  알 수 있다면 운영이 신고를 놓친다.
api('/reports?open=open&limit=1').then(function (d) {
  var b = document.getElementById('rbadge');
  b.textContent = d.counts.open > 0 ? String(d.counts.open) : '';
}).catch(function () {});

var rfilters = ['ropen', 'rtype', 'rreason'];
for (var ri = 0; ri < rfilters.length; ri++) {
  document.getElementById(rfilters[ri]).addEventListener('change', loadReports);
}

// ── 개요 ──
function renderOverview(d) {
  var t = d.totals;
  var h = '<div class="cards">';
  h += '<div class="card"><div class="k">총 적재 행수</div><div class="v">' + fmt(t.rows) + '</div>' +
       '<div class="s">' + d.tables.filter(function (x) { return x.kind === 'table'; }).length + '개 테이블 · ' + size(d.dbBytes) + '</div></div>';
  h += '<div class="card"><div class="k">오늘 신규 (' + d.kstDate + ')</div><div class="v">' + fmt(t.newToday) + '</div>' +
       '<div class="s">총량 대비 <b>' + pctStr(pct(t.newToday, t.rows)) + '</b> 순증</div></div>';
  h += '<div class="card"><div class="k">오늘 수집(갱신 포함)</div><div class="v">' + fmt(t.touchedToday) + '</div>' +
       '<div class="s">총량 대비 <b>' + pctStr(pct(t.touchedToday, t.rows)) + '</b> 를 오늘 받아옴</div></div>';
  h += '<div class="card"><div class="k">최근 7일 신규</div><div class="v">' + fmt(t.new7d) + '</div>' +
       '<div class="s">일평균 ' + fmt(Math.round(t.new7d / 7)) + ' · 총량 대비 <b>' + pctStr(pct(t.new7d, t.rows)) + '</b></div></div>';
  h += '</div>';
  if (t.partial) h += '<div class="note">⚠️ 일부 테이블이 집계 시간을 초과해 합계에서 빠졌습니다(아래 표에서 <span class="pill warn">측정 생략</span>).</div>';

  if (d.coverage.length) {
    h += '<h2>수집 진행률</h2><div class="cov">';
    d.coverage.forEach(function (c) {
      var cls = c.pct >= 99 ? 'good' : (c.pct >= 70 ? '' : 'warn');
      h += '<div class="item"><div class="top"><span class="lbl">' + esc(c.label) + '</span>' +
           '<span class="pct" style="color:var(--' + (cls === 'good' ? 'good' : cls === 'warn' ? 'warn' : 'accent') + ')">' + c.pct.toFixed(1) + '%</span></div>' +
           '<div class="note">' + esc(c.note) + '</div>' + bar(c.pct) +
           '<div class="cnt">' + fmt(c.done) + ' / ' + fmt(c.total) + ' · 남음 ' + fmt(Math.max(0, c.total - c.done)) + '</div></div>';
    });
    h += '</div>';
  }

  h += '<h2>테이블별 적재 현황</h2><div class="panel scroll"><table><thead><tr>' +
       '<th>테이블</th><th class="num">행수</th><th class="num">오늘 신규</th><th class="num">비중</th>' +
       '<th class="num">7일 신규</th><th class="num">오늘 갱신</th><th class="num">비중</th>' +
       '<th>마지막 갱신</th><th class="num">크기</th></tr></thead><tbody>';
  d.tables.slice().sort(function (a, b) { return (b.rows || b.estRows) - (a.rows || a.estRows); }).forEach(function (s) {
    var rows = s.rows;
    h += '<tr><td>' + esc(s.name) + (s.kind === 'view' ? ' <span class="pill">뷰</span>' : '') +
         (s.timedOut ? ' <span class="pill warn">측정 생략</span>' : '') + '</td>';
    h += '<td class="num">' + (rows == null ? '≈' + fmt(s.estRows) : fmt(rows)) + '</td>';
    h += '<td class="num">' + fmt(s.newToday) + '</td>';
    h += '<td class="num dim">' + (s.newToday != null && rows ? pctStr(pct(s.newToday, rows)) : '—') + '</td>';
    h += '<td class="num dim">' + fmt(s.new7d) + '</td>';
    h += '<td class="num">' + fmt(s.touchedToday) + '</td>';
    h += '<td class="num dim">' + (s.touchedToday != null && rows ? pctStr(pct(s.touchedToday, rows)) : '—') + '</td>';
    h += '<td class="dim">' + ago(s.lastUpdated) + '</td>';
    h += '<td class="num dim">' + size(s.bytes) + '</td></tr>';
  });
  h += '</tbody></table></div>';

  if (d.queues.length) {
    h += '<h2>다일(多日) 작업큐</h2><div class="panel scroll"><table><thead><tr><th>큐</th><th>상태</th><th class="num">건수</th></tr></thead><tbody>';
    d.queues.forEach(function (q) {
      h += '<tr><td>' + esc(q.queue) + '</td><td>' + esc(q.status) + '</td><td class="num">' + fmt(q.n) + '</td></tr>';
    });
    h += '</tbody></table></div>';
  }

  if (d.runs.length) {
    h += '<h2>연관관광지 실행 로그</h2><div class="panel scroll"><table><thead><tr>' +
         '<th>#</th><th class="num">요청</th><th class="num">작업</th><th class="num">레코드</th><th>종료사유</th><th>시작</th><th>종료</th></tr></thead><tbody>';
    d.runs.forEach(function (r) {
      h += '<tr><td>' + r.id + '</td><td class="num">' + fmt(r.requests_made) + '</td><td class="num">' + fmt(r.tasks_done) +
           '</td><td class="num">' + fmt(r.records_upserted) + '</td><td>' + esc(r.stopped_reason || '—') +
           '</td><td class="dim">' + esc(r.started || '—') + '</td><td class="dim">' + esc(r.finished || '—') + '</td></tr>';
    });
    h += '</tbody></table></div>';
  }

  document.getElementById('overview').innerHTML = h;
  document.getElementById('dbmeta').textContent = d.database + ' · ' + new Date(d.generatedAt).toLocaleTimeString('ko-KR');
}

function loadOverview() {
  document.getElementById('overview').innerHTML = '<div class="loading">집계 중… (큰 테이블은 몇 초 걸립니다)</div>';
  api('/overview').then(renderOverview).catch(function (e) {
    document.getElementById('overview').innerHTML = '<div class="err">' + esc(e.message) + '</div>';
  });
}
document.getElementById('refresh').addEventListener('click', function () {
  var on = document.querySelector('section.on').id;
  if (on === 'overview') loadOverview();
  else if (on === 'tables') loadTable();
  else if (on === 'reports') loadReports();
});

// ── 테이블 브라우저 ──
var offset = 0, LIMIT = 50;
function loadTableList() {
  api('/tables').then(function (d) {
    var sel = document.getElementById('tsel');
    // 큰 테이블부터 — 알파벳순으로 두면 첫 선택이 빈 테이블이 되는 일이 잦다.
    sel.innerHTML = d.tables.slice().sort(function (a, b) { return b.estRows - a.estRows; }).map(function (t) {
      return '<option value="' + esc(t.name) + '">' + esc(t.name) + ' (' + fmt(t.estRows) + '행)</option>';
    }).join('');
    window.__tablesReady = true;
    loadTable();
  });
}
function loadTable() {
  var name = document.getElementById('tsel').value;
  if (!name) return;
  document.getElementById('tbody').innerHTML = '<div class="loading">불러오는 중…</div>';
  api('/browse?table=' + encodeURIComponent(name) + '&limit=' + LIMIT + '&offset=' + offset)
    .then(function (d) {
      document.getElementById('tbody').innerHTML = renderGrid(d.columns, d.rows);
      document.getElementById('tinfo').textContent = d.rows.length
        ? name + ' · ' + (offset + 1) + '–' + (offset + d.rows.length) + '행'
        : name + ' · 행 없음';
      document.getElementById('tprev').disabled = offset === 0;
      document.getElementById('tnext').disabled = d.rows.length < LIMIT;
    })
    .catch(function (e) { document.getElementById('tbody').innerHTML = '<div class="err">' + esc(e.message) + '</div>'; });
}
function renderGrid(cols, rows) {
  if (!rows.length) return '<div class="loading">결과 없음</div>';
  var h = '<table><thead><tr>' + cols.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '</tr></thead><tbody>';
  rows.forEach(function (r) {
    h += '<tr>' + r.map(function (v) { return '<td>' + cell(v) + '</td>'; }).join('') + '</tr>';
  });
  return h + '</tbody></table>';
}
document.getElementById('tsel').addEventListener('change', function () { offset = 0; loadTable(); });
document.getElementById('tprev').addEventListener('click', function () { offset = Math.max(0, offset - LIMIT); loadTable(); });
document.getElementById('tnext').addEventListener('click', function () { offset += LIMIT; loadTable(); });

// ── SQL 콘솔 ──
var SAMPLES = [
  ['반려동물 · 콘텐츠유형별', "select contenttypeid, count(*) n from pet_tour_poi group by 1 order by 2 desc"],
  ['반려동물 · 동반유형 분포', "select coalesce(nullif(acmpy_type_cd,''),'(빈값)') v, count(*) n from pet_tour_detail group by 1 order by 2 desc"],
  ['오늘 신규 · 테이블 상위', "select 'pet_tour_poi' t, count(*) n from pet_tour_poi where created_at >= current_date union all select 'kor_detail', count(*) from kor_detail where created_at >= current_date order by 2 desc"],
  ['무장애 · 접근성 보유율', "select contenttypeid, count(*) n, count(*) filter (where has_access) acc from barrier_free group by 1 order by 2 desc"],
  ['최근 후기', "select id, location_nm, rating, left(body, 40) body, created_at from reviews order by created_at desc"]
];
var sampleSel = document.getElementById('samples');
SAMPLES.forEach(function (s, i) {
  var o = document.createElement('option'); o.value = String(i); o.textContent = s[0]; sampleSel.appendChild(o);
});
sampleSel.addEventListener('change', function () {
  if (sampleSel.value === '') return;
  document.getElementById('q').value = SAMPLES[Number(sampleSel.value)][1];
  sampleSel.value = '';
});
function runQuery() {
  var sql = document.getElementById('q').value;
  if (!sql.trim()) return;
  document.getElementById('qerr').textContent = '';
  document.getElementById('qinfo').textContent = '실행 중…';
  document.getElementById('qout').innerHTML = '';
  api('/query', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sql: sql })
  }).then(function (d) {
    document.getElementById('qout').innerHTML = renderGrid(d.columns, d.rows);
    document.getElementById('qinfo').textContent =
      d.rowCount + '행 · ' + d.ms + 'ms' + (d.truncated ? ' · 상한 도달(잘림)' : '');
  }).catch(function (e) {
    document.getElementById('qinfo').textContent = '';
    document.getElementById('qerr').textContent = e.message;
  });
}
document.getElementById('run').addEventListener('click', runQuery);
document.getElementById('q').addEventListener('keydown', function (e) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); runQuery(); }
});

loadOverview();
`;
