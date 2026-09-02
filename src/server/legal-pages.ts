// 개인정보 처리방침 · 이용약관 — 서버가 직접 서빙한다(/privacy, /terms).
//
// ── 왜 서버가 뱉나
//  앱스토어는 **로그인 없이 접근되는 공개 URL** 을 요구한다(App Store Connect › App Information).
//  moduwa.app 이 이미 이 서버를 가리키고 있고 초대 대체 페이지(/i/:code)와 유니버설 링크 파일도
//  여기서 나가므로, 별도 호스팅을 붙이지 않는다. 문서가 코드와 같은 저장소에 있으면 수집 항목이
//  바뀔 때 방침도 같은 커밋에서 고칠 수 있다 — 실제와 어긋난 방침이 리젝 사유다.
//
// ⚠️ **문서는 구현과 일치해야 한다.** 아래 내용은 스키마 감사 결과로 쓰였다:
//     · 서버는 사용자 위치를 받지 않는다(좌표 컬럼은 전부 관광지 데이터)
//     · 소셜 로그인은 제공자에게 정보를 **보내지 않는다** — 공개키(JWKS)로 서명만 검증한다
//     · 탈퇴는 작성자를 익명화하고 콘텐츠는 남긴다(auth-routes.ts 의 DELETE /me 그대로)
//     · authors.access_features = 장애 관련 정보 → **민감정보**, 선택 항목, 별도 동의 대상
//    수집 항목이나 위탁 업체가 바뀌면 이 파일도 같은 커밋에서 고친다.
//
// ⚠️ 법률 검토를 대체하지 않는다. 민감정보를 다루는 서비스이므로 제출 전 검토를 권한다.

/** 방침에 공개되는 운영자 정보. 개인 개발자라 상호·사업자번호가 없고 성명으로 갈음한다. */
const OPERATOR = {
  /** 서비스명 */
  service: '모두와',
  /**
   * 운영자 성명.
   *
   * ⚠️ 개인정보보호법은 처리자와 보호책임자를 특정하도록 요구하고, 개인 개발자 계정은
   *    애플이 이미 실명을 앱스토어에 공개하므로 새로 노출되는 정보는 아니다.
   */
  name: '',
  /** 사용자 문의 — 심사 규칙 1.2 가 요구하는 공개 연락처 */
  contact: 'help@moduwa.app',
  /** 개인정보 관련 문의 · 보호책임자 연락처 */
  privacyContact: 'privacy@moduwa.app',
  /** 시행일 */
  effective: '2026-09-02',
} as const;

/** 운영자 성명이 비어 있으면 그 자리를 눈에 보이게 표시한다 — 조용히 빈칸으로 배포되지 않게. */
const who = OPERATOR.name || '(운영자 성명 미기재)';

const STYLE = `
  :root{--fg:#1C2B33;--muted:#5B6B73;--bg:#F7F8F8;--panel:#fff;--accent:#0B5F6B;--tint:#EEF4F5;--line:#E3E8EA}
  @media (prefers-color-scheme:dark){
    :root{--fg:#E6EBED;--muted:#9BAAB1;--bg:#12181B;--panel:#1A2226;--accent:#5FBECB;--tint:#222E33;--line:#2A363B}
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);line-height:1.75;
       font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Pretendard','Noto Sans KR',sans-serif;
       font-size:15px;-webkit-text-size-adjust:100%}
  .wrap{max-width:720px;margin:0 auto;padding:32px 20px 72px}
  .brand{font-weight:700;font-size:14px;color:var(--accent);letter-spacing:.02em;margin-bottom:24px}
  h1{font-size:24px;font-weight:700;letter-spacing:-.02em;margin:0 0 6px}
  .eff{color:var(--muted);font-size:13px;margin:0 0 28px}
  h2{font-size:16px;font-weight:700;margin:34px 0 10px;padding-top:20px;border-top:1px solid var(--line)}
  h2:first-of-type{border-top:none;padding-top:0}
  h3{font-size:14px;font-weight:700;margin:20px 0 6px;color:var(--accent)}
  p,li{margin:0 0 10px}
  ul{padding-left:20px;margin:0 0 12px}
  .box{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:14px 0}
  .box.warn{background:var(--tint);border-color:var(--accent)}
  .box p:last-child,.box li:last-child{margin-bottom:0}
  table{width:100%;border-collapse:collapse;margin:12px 0;font-size:14px;display:block;overflow-x:auto;
        white-space:nowrap}
  th,td{padding:9px 12px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}
  th{font-size:12.5px;color:var(--muted);font-weight:600;background:var(--panel)}
  code{font-family:ui-monospace,Menlo,monospace;font-size:13px;background:var(--tint);
       padding:1px 5px;border-radius:4px}
  a{color:var(--accent)}
  footer{margin-top:44px;padding-top:20px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}
`;

const shell = (title: string, body: string) =>
  `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${OPERATOR.service} — ${title}</title>
<style>${STYLE}</style></head><body><div class="wrap">
<div class="brand">${OPERATOR.service}</div>
<h1>${title}</h1>
<p class="eff">시행일 ${OPERATOR.effective}</p>
${body}
<footer>${OPERATOR.service} · 문의 <a href="mailto:${OPERATOR.contact}">${OPERATOR.contact}</a><br>
<a href="/privacy">개인정보 처리방침</a> · <a href="/terms">이용약관</a></footer>
</div></body></html>`;

export const privacyPage = () => shell('개인정보 처리방침', `
<p>${OPERATOR.service}(이하 "서비스")는 무장애 여행 정보를 제공하는 앱입니다. 서비스는 이용자의 개인정보를
소중히 다루며, 「개인정보 보호법」에 따라 아래와 같이 처리방침을 알립니다.</p>

<div class="box warn">
<p><b>먼저 알려드립니다.</b></p>
<ul>
<li>서비스는 <b>이용자의 위치를 수집하지 않습니다.</b> 서버에 위치를 전송받는 기능이 없습니다.</li>
<li>서비스는 <b>광고 식별자를 수집하지 않고, 앱·웹사이트 간 활동을 추적하지 않습니다.</b></li>
<li>서비스는 개인정보를 <b>판매하거나 광고 목적으로 제3자에게 제공하지 않습니다.</b></li>
</ul>
</div>

<h2>1. 수집하는 개인정보 항목</h2>
<table>
<tr><th>구분</th><th>항목</th><th>수집 방법</th></tr>
<tr><td>필수 (계정)</td><td>이메일 주소, 비밀번호(암호화 저장), 닉네임</td><td>회원가입 시 이용자 입력</td></tr>
<tr><td>필수 (소셜 로그인)</td><td>제공자 식별자, 이메일 주소</td><td>Apple·Google·Kakao 로그인 시 전달받음</td></tr>
<tr><td>선택 (민감정보)</td><td>접근성 특성(휠체어 이용, 시각·청각 등 이동·이용 편의 정보)</td><td>온보딩·프로필에서 이용자가 직접 선택</td></tr>
<tr><td>선택</td><td>프로필 사진</td><td>이용자 등록</td></tr>
<tr><td>자동 생성</td><td>기기 식별자, 세션 정보, 푸시 알림 토큰, 접속 일시</td><td>서비스 이용 시 자동 생성</td></tr>
<tr><td>이용 기록</td><td>저장한 장소, 좋아요, 차단 목록, 신고 내역</td><td>기능 사용 시 생성</td></tr>
<tr><td>이용자 작성물</td><td>게시글·후기·댓글·여행 플랜과 첨부 사진</td><td>이용자가 직접 작성</td></tr>
</table>
<p>비밀번호는 복호화할 수 없는 형태로 변환해 저장하며, 운영자도 원래 값을 알 수 없습니다.
푸시 알림 토큰은 알림을 허용한 경우에만 수집합니다.</p>

<h2>2. 민감정보 처리에 관한 별도 안내</h2>
<div class="box warn">
<p><b>접근성 특성은 「개인정보 보호법」상 민감정보에 해당합니다.</b></p>
<ul>
<li><b>선택 항목입니다.</b> 등록하지 않아도 서비스의 모든 기능을 이용할 수 있습니다.</li>
<li>수집 목적은 <b>무장애 여행 코스 추천과 정보 표시</b>이며, 다른 목적으로 이용하지 않습니다.</li>
<li>이 항목은 <b>다른 이용자에게 공개되지 않습니다.</b></li>
<li>수집·이용에 대해 <b>다른 항목과 분리된 별도 동의</b>를 받으며, 동의를 거부해도 불이익이 없습니다.</li>
<li>프로필 편집에서 <b>언제든 삭제</b>할 수 있습니다.</li>
</ul>
</div>

<h2>3. 개인정보의 처리 목적</h2>
<ul>
<li><b>회원 식별과 인증</b> — 로그인, 세션 유지, 이메일 인증, 비밀번호 재설정</li>
<li><b>서비스 제공</b> — 여행 플랜 작성·공유, 후기·게시글 작성, 장소 저장</li>
<li><b>무장애 정보 제공</b> — 접근성 특성에 맞춘 코스 추천(선택 동의 시)</li>
<li><b>알림 발송</b> — 좋아요·댓글·플랜 합류 알림(알림 허용 시)</li>
<li><b>안전한 이용 환경 유지</b> — 신고·차단 처리, 부정 이용 방지</li>
</ul>

<h2>4. 보유 및 이용 기간</h2>
<table>
<tr><th>항목</th><th>보유 기간</th></tr>
<tr><td>계정 정보(이메일·비밀번호·닉네임·프로필 사진)</td><td><b>회원 탈퇴 시 즉시 삭제</b></td></tr>
<tr><td>접근성 특성(민감정보)</td><td>이용자가 삭제하거나 탈퇴 시 즉시 삭제</td></tr>
<tr><td>소셜 로그인 연동 정보</td><td>탈퇴 시 즉시 삭제(연동도 해제)</td></tr>
<tr><td>세션 정보</td><td>최종 사용 후 90일, 생성 후 180일 경과 시 만료</td></tr>
<tr><td>푸시 알림 토큰</td><td>알림 해제 또는 탈퇴 시 즉시 삭제</td></tr>
<tr><td>이메일 인증·비밀번호 재설정 코드</td><td>발급 후 10분</td></tr>
<tr><td>이용자 작성물(게시글·후기·댓글·플랜)</td><td>이용자가 삭제할 때까지. 탈퇴 시에는 <b>작성자 표시를 지운 상태로</b> 유지(아래 5항)</td></tr>
<tr><td>신고 내역</td><td>안전한 이용 환경 유지를 위해 보관</td></tr>
</table>

<h2>5. 회원 탈퇴와 작성물의 처리</h2>
<p>앱 안에서 <b>설정 → 회원 탈퇴</b>로 언제든 계정을 삭제할 수 있으며, <b>되돌릴 수 없습니다.</b></p>
<div class="box">
<p><b>탈퇴하면 즉시 삭제되는 것</b></p>
<ul>
<li>이메일 주소, 비밀번호, 닉네임, 프로필 사진, 접근성 특성</li>
<li>소셜 로그인 연동 정보 — 같은 소셜 계정으로 다시 로그인하면 <b>새 계정</b>이 됩니다</li>
<li>로그인 세션, 기기 정보, 푸시 알림 토큰 — 탈퇴 후 알림이 발송되지 않습니다</li>
<li>저장한 장소, 좋아요, 차단 목록</li>
<li>혼자 사용하던 여행 플랜</li>
</ul>
<p><b>남는 것</b></p>
<ul>
<li>게시글·후기·댓글은 <b>작성자 표시를 "탈퇴한 사용자"로 바꾼 상태로</b> 남습니다.
함께 대화한 다른 이용자의 글이 함께 사라지지 않도록 하기 위한 것으로, 여기에는 개인정보가 남지 않습니다.
탈퇴 전에 직접 삭제하시면 작성물도 함께 사라집니다.</li>
<li>여러 명이 함께 편집하던 플랜은 <b>다른 참여자에게 소유권이 넘어갑니다.</b> 참여자가 없으면 삭제됩니다.</li>
<li>신고 내역은 안전한 이용 환경 유지를 위해 보관됩니다.</li>
</ul>
</div>
<p>Apple 계정으로 로그인한 경우, 탈퇴 시 서비스가 Apple에 <b>연동 해제(토큰 폐기)를 요청</b>합니다.</p>

<h2>6. 개인정보의 제3자 제공</h2>
<p>서비스는 개인정보를 제3자에게 제공하지 않습니다.</p>
<div class="box">
<p><b>소셜 로그인에 관하여.</b> Apple·Google·Kakao 로그인은 각 제공자가 발급한 인증 토큰을
서비스가 <b>검증</b>하는 방식입니다. 서비스는 이 과정에서 <b>제공자에게 이용자의 정보를 보내지 않습니다.</b>
제공자가 공개한 검증용 공개키만 내려받아 서버에서 서명을 확인합니다.</p>
</div>

<h2>7. 개인정보 처리의 위탁</h2>
<table>
<tr><th>수탁자</th><th>위탁 업무</th><th>제공되는 정보</th></tr>
<tr><td>Railway Corp.</td><td>서버 및 데이터베이스 운영</td><td>서비스 이용에 필요한 개인정보 전반</td></tr>
<tr><td>Resend, Inc.</td><td>인증·안내 메일 발송</td><td>이메일 주소, 메일 본문(인증 코드)</td></tr>
<tr><td>Apple Inc.</td><td>iOS 푸시 알림 발송</td><td>푸시 알림 토큰, 알림 문구</td></tr>
</table>
<p>수탁자가 위탁 목적 외로 개인정보를 처리하지 않도록 관리·감독합니다.</p>

<h2>8. 개인정보의 국외 이전</h2>
<p>서비스는 서버를 국외에 두고 있어 개인정보가 국외로 이전됩니다.</p>
<table>
<tr><th>이전받는 자</th><th>국가</th><th>이전 항목</th><th>이전 시기·방법</th></tr>
<tr><td>Railway Corp.</td><td>미국</td><td>서비스 이용에 필요한 개인정보 전반</td><td>서비스 이용 시 네트워크를 통한 전송</td></tr>
<tr><td>Resend, Inc.</td><td>미국</td><td>이메일 주소, 인증 코드</td><td>메일 발송 시</td></tr>
<tr><td>Apple Inc.</td><td>미국</td><td>푸시 알림 토큰, 알림 문구</td><td>알림 발송 시</td></tr>
</table>
<p>이용자는 국외 이전을 거부할 수 있으나, 거부하는 경우 서비스 이용이 제한됩니다.
이전 목적은 위 7항의 위탁 업무 수행과 같으며, 보유 기간은 4항과 같습니다.</p>

<h2>9. 이용자의 권리와 행사 방법</h2>
<ul>
<li><b>열람·정정</b> — 앱의 프로필 편집에서 닉네임·프로필 사진·접근성 특성을 확인하고 수정할 수 있습니다.</li>
<li><b>삭제</b> — 앱의 설정 → 회원 탈퇴로 계정과 개인정보를 삭제할 수 있습니다.</li>
<li><b>처리 정지</b> — 알림은 앱 설정에서, 접근성 특성은 프로필 편집에서 언제든 해제할 수 있습니다.</li>
<li><b>동의 철회</b> — 민감정보 동의는 접근성 특성을 삭제하면 철회됩니다.</li>
</ul>
<p>위 권리 행사는 <a href="mailto:${OPERATOR.privacyContact}">${OPERATOR.privacyContact}</a>로 요청하실 수도 있으며,
지체 없이 처리합니다. 법정대리인이나 위임받은 자를 통해서도 요청할 수 있습니다.</p>

<h2>10. 개인정보의 파기</h2>
<p>보유 기간이 지나거나 처리 목적이 달성된 개인정보는 지체 없이 파기합니다.
전자적 파일은 복구할 수 없는 방법으로 삭제하고, 출력물이 있는 경우 소각 또는 파쇄합니다.</p>

<h2>11. 안전성 확보 조치</h2>
<ul>
<li>비밀번호는 복호화할 수 없는 형태로 변환해 저장합니다.</li>
<li>로그인 세션 토큰은 원본을 저장하지 않고 변환된 값만 보관합니다.</li>
<li>모든 통신은 HTTPS로 암호화합니다.</li>
<li>개인정보에 접근할 수 있는 인원을 운영자로 최소화하고, 접근 수단을 분리해 관리합니다.</li>
<li>로그인·인증 요청 횟수를 제한해 무단 접근 시도를 차단합니다.</li>
</ul>

<h2>12. 만 14세 미만 아동</h2>
<p>서비스는 만 14세 미만 아동의 회원가입을 받지 않으며, 아동의 개인정보를 의도적으로 수집하지 않습니다.
만 14세 미만 아동의 개인정보가 수집된 사실을 알게 된 경우 지체 없이 삭제합니다.</p>

<h2>13. 개인정보 보호책임자</h2>
<div class="box">
<p><b>개인정보 보호책임자</b><br>
성명: ${who}<br>
연락처: <a href="mailto:${OPERATOR.privacyContact}">${OPERATOR.privacyContact}</a></p>
<p>개인정보 처리에 관한 문의·불만·피해 구제를 접수하며, 지체 없이 답변드립니다.</p>
</div>

<h2>14. 권익침해 구제 방법</h2>
<p>개인정보 침해로 상담이나 피해 구제가 필요한 경우 아래 기관에 문의하실 수 있습니다.</p>
<ul>
<li>개인정보분쟁조정위원회 — 1833-6972 (<a href="https://www.kopico.go.kr">www.kopico.go.kr</a>)</li>
<li>개인정보침해신고센터 — 118 (<a href="https://privacy.kisa.or.kr">privacy.kisa.or.kr</a>)</li>
<li>대검찰청 사이버수사과 — 1301</li>
<li>경찰청 사이버수사국 — 182</li>
</ul>

<h2>15. 처리방침의 변경</h2>
<p>이 방침이 변경되는 경우 변경 사항과 시행일을 이 페이지에 게시하고, 중요한 변경은 앱 안에서
별도로 안내합니다.</p>
`);

export const termsPage = () => shell('이용약관', `
<h2>제1조 (목적)</h2>
<p>이 약관은 ${OPERATOR.service}(이하 "서비스")의 이용 조건과 절차, 이용자와 운영자의 권리·의무를
정하는 것을 목적으로 합니다.</p>

<h2>제2조 (약관의 효력과 변경)</h2>
<p>이 약관은 서비스 화면에 게시함으로써 효력이 발생합니다. 운영자는 필요한 경우 약관을 변경할 수 있고,
변경된 약관은 시행일과 함께 게시합니다. 이용자가 변경에 동의하지 않는 경우 회원 탈퇴할 수 있습니다.</p>

<h2>제3조 (회원가입과 계정)</h2>
<ul>
<li>이용자는 이메일 또는 소셜 로그인으로 계정을 만들 수 있습니다.</li>
<li>계정은 본인만 사용해야 하며, 타인에게 양도하거나 대여할 수 없습니다.</li>
<li>만 14세 미만은 회원가입할 수 없습니다.</li>
<li>이용자는 <b>앱 안에서 언제든 회원 탈퇴</b>할 수 있습니다. 탈퇴 시 처리는 개인정보 처리방침
5항을 따릅니다.</li>
</ul>

<h2>제4조 (서비스의 내용)</h2>
<p>서비스는 무장애 여행 정보 조회, 여행 플랜 작성·공유, 장소 후기와 게시글 작성 기능을 제공합니다.
관광 정보는 한국관광공사 TourAPI 등 공공데이터를 기반으로 하며, 현장 상황과 다를 수 있습니다.</p>
<div class="box">
<p><b>무장애 정보의 한계.</b> 서비스가 제공하는 접근성 정보는 공공데이터와 이용자 후기를 근거로 하며,
시설의 실제 상태와 다를 수 있습니다. 방문 전 해당 시설에 직접 확인하시기를 권합니다.</p>
</div>

<h2>제5조 (이용자 작성물)</h2>
<p>이용자가 작성한 게시글·후기·댓글·사진(이하 "작성물")의 권리는 이용자에게 있습니다.
운영자는 서비스 제공과 노출에 필요한 범위에서만 작성물을 사용합니다.</p>

<h2>제6조 (금지 행위)</h2>
<div class="box warn">
<p><b>다음 작성물은 허용되지 않으며, 운영자는 이를 무관용 원칙으로 처리합니다.</b></p>
<ul>
<li>타인을 비방·모욕·협박하거나 괴롭히는 내용</li>
<li>차별·혐오를 조장하는 내용, 특히 장애를 이유로 한 차별적 표현</li>
<li>음란물, 성적으로 노골적인 내용, 폭력적이거나 잔혹한 내용</li>
<li>타인의 개인정보를 동의 없이 공개하는 내용</li>
<li>허위 정보, 광고·스팸, 불법 상품·서비스의 거래</li>
<li>타인의 저작권·상표권 등 권리를 침해하는 내용</li>
<li>서비스의 정상적인 운영을 방해하는 행위</li>
</ul>
</div>

<h2>제7조 (신고와 차단, 운영자의 조치)</h2>
<ul>
<li>이용자는 게시글·댓글·후기를 <b>신고</b>할 수 있고, 다른 이용자를 <b>차단</b>할 수 있습니다.
차단하면 그 이용자의 작성물이 내 화면에서 보이지 않고, 그 이용자는 내 작성물에 댓글을 쓸 수 없습니다.</li>
<li>운영자는 신고를 <b>접수 순서와 심각도에 따라 검토</b>하고, 판단 결과를 기록합니다.</li>
<li>제6조를 위반한 작성물은 <b>삭제</b>할 수 있고, 반복·중대한 위반 계정은 <b>이용 제한 또는 삭제</b>할 수
있습니다.</li>
<li>⚠️ <b>신고가 접수되었다는 사실만으로 작성물이 자동으로 숨겨지지는 않습니다.</b> 신고 기능이
타인의 글을 지우는 수단으로 쓰이지 않도록 하기 위한 것으로, 삭제 여부는 운영자가 검토해 판단합니다.</li>
<li>신고 대상이 되는 내용을 발견하셨다면 <a href="mailto:${OPERATOR.contact}">${OPERATOR.contact}</a>로도
알려주실 수 있습니다.</li>
</ul>

<h2>제8조 (서비스의 중단)</h2>
<p>운영자는 점검·장애·불가피한 사유로 서비스를 일시 중단할 수 있으며, 사전에 알릴 수 있는 경우
앱 또는 이 페이지를 통해 안내합니다.</p>

<h2>제9조 (면책)</h2>
<p>운영자는 천재지변, 이용자의 귀책 사유, 제3자의 불법 행위로 인한 손해에 대해 책임을 지지 않습니다.
이용자 사이 또는 이용자와 제3자 사이에 발생한 분쟁에 대해 운영자는 개입할 의무가 없습니다.</p>

<h2>제10조 (준거법과 분쟁 해결)</h2>
<p>이 약관은 대한민국 법률에 따릅니다. 서비스 이용과 관련한 분쟁은 운영자의 주소지를 관할하는
법원을 관할 법원으로 합니다.</p>

<h2>제11조 (운영자 정보)</h2>
<div class="box">
<p>서비스명: ${OPERATOR.service}<br>
운영자: ${who} (개인 개발자)<br>
문의: <a href="mailto:${OPERATOR.contact}">${OPERATOR.contact}</a></p>
</div>
`);
