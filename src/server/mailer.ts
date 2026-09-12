// 메일 발송 — 이 파일만 provider 를 안다.
//
// 호출부(auth-routes)는 "메일을 보낸다"만 알고 누가 보내는지는 모른다. 국내 수신률을 재보고
// Resend → NCP Cloud Outbound Mailer / AWS SES 로 바꿀 때 이 파일 안쪽만 고치면 된다.
// (accounts.ts 가 인증 provider 를 모르게 만들어 둔 것과 같은 이유다)
//
// SMTP 를 쓰지 않는 이유: Railway 같은 PaaS 는 스팸 방지로 아웃바운드 25/587 을 막는 경우가
// 많다. 로컬에서 되던 것이 배포하면 조용히 안 되는, 제일 골치아픈 형태로 터진다.
// HTTP API 는 443 만 쓰므로 그 문제가 없고 새 의존성도 필요 없다(fetch).
import { config } from '../config';

export type Mail = {
  to: string;
  subject: string;
  /** 평문. HTML 을 쓰지 않는 이유는 아래 buildCodeMail 주석 참고. */
  text: string;
};

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * 메일을 보낸다.
 *
 * ⚠️ **던지지 않는다.** 발송 실패로 요청이 500 이 되면 두 가지가 나빠진다 —
 *  ① 비밀번호 찾기에서 "이 주소는 발송이 실패했다"가 곧 "이 주소는 가입돼 있다"는 신호가 된다.
 *  ② 가입은 이미 성공했는데 인증 메일만 실패한 경우, 500 을 받은 앱이 재시도하면 email_taken 이
 *     나서 사용자는 "가입도 안 되고 로그인도 안 되는" 상태로 보인다.
 *  실패는 서버 로그에 남기고, 사용자는 재발송을 누르면 된다.
 */
export async function sendMail(mail: Mail): Promise<boolean> {
  // 키가 없으면 콘솔로 보낸다. 로컬 개발에서는 이게 실제 발송보다 편하다 —
  //  메일함을 열 필요 없이 터미널에서 인증 코드를 바로 집어올 수 있다.
  if (!config.mail.resendApiKey) {
    console.log(
      `[mail] (콘솔 발송 — RESEND_API_KEY 미설정)\n`
      + `  to      : ${mail.to}\n`
      + `  subject : ${mail.subject}\n`
      + mail.text.split('\n').map((l) => `  | ${l}`).join('\n'),
    );
    return true;
  }

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.mail.resendApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: config.mail.from,
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
      }),
    });
    if (!res.ok) {
      // 응답 본문에 사유가 있다(도메인 미인증, from 불일치 등). 진단에 꼭 필요하다.
      console.error(`[mail] 발송 실패 ${res.status}: ${(await res.text()).slice(0, 500)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[mail] 발송 예외:', err);
    return false;
  }
}

/**
 * 비밀번호 무효화 알림.
 *
 * 인증 전 이메일 계정에 검증된 소셜 로그인(구글·애플)이 자동 연결되면 서버가 그 계정의
 * 이메일 비밀번호를 지운다(accounts.signIn 주석의 선점 탈취). 그 사실을 **주소의 주인**에게
 * 알린다 — 앱 화면은 방금 소셜로 들어온 사람만 보는데, 만약 그 소셜 계정이 탈취된 것이었다면
 * 원래 주인은 다음 로그인 실패 때까지 모른다. 비밀번호 변경 알림과 같은 성격의 보안 메일이다.
 *
 * 코드도 링크도 없다 — 이 메일로 할 수 있는 일은 없고, 앱의 "비밀번호 찾기"가 복구 경로다.
 */
export function buildPasswordResetNoticeMail(providerLabel: string): Omit<Mail, 'to'> {
  return {
    subject: '[모두와] 이메일 비밀번호가 초기화되었습니다',
    text: [
      `방금 이 주소의 ${providerLabel} 계정으로 모두와에 로그인하면서, 같은 주소로 만들어 둔`,
      '이메일 계정이 그 로그인에 연결되었습니다.',
      '',
      '연결된 이메일 계정은 이메일 인증을 마치지 않은 상태였기 때문에, 안전을 위해',
      '그 계정의 이메일 비밀번호를 지우고 모든 기기에서 로그아웃했습니다.',
      '글과 플랜은 그대로 있습니다.',
      '',
      `본인이 하신 것이라면 ${providerLabel} 로그인을 그대로 쓰시면 됩니다.`,
      '이메일 비밀번호가 다시 필요하면 앱의 "비밀번호 찾기"에서 새로 설정하세요.',
      '',
      `본인이 아니라면 ${providerLabel} 계정의 보안(비밀번호·2단계 인증)을 먼저 확인하신 뒤,`,
      '앱의 "비밀번호 찾기"로 이 주소의 비밀번호를 새로 설정하세요.',
    ].join('\n'),
  };
}

/**
 * 인증 코드 메일 본문.
 *
 * HTML 을 쓰지 않는다 — 국내 수신 서버는 이미지·링크가 많은 메일을 더 엄격하게 본다.
 * 비밀번호 재설정 메일이 스팸함으로 가면 계정 복구가 통째로 막히므로, 도달률이 최우선이다.
 * 링크도 넣지 않는다(moduwa.app 에 아직 페이지가 없다 — 눌러도 도착할 곳이 없으면
 * 안 넣는 편이 낫다. 웹이 생기면 그때 추가한다).
 */
export function buildCodeMail(purpose: 'verify' | 'reset', code: string, minutes: number): Omit<Mail, 'to'> {
  if (purpose === 'verify') {
    return {
      subject: '[모두와] 이메일 인증 코드',
      text: [
        '모두와 이메일 인증 코드입니다.',
        '',
        `    ${code}`,
        '',
        `앱에서 위 6자리 숫자를 입력해주세요. ${minutes}분 동안 유효합니다.`,
        '',
        '이 메일을 요청하지 않으셨다면 무시하셔도 됩니다.',
      ].join('\n'),
    };
  }
  return {
    subject: '[모두와] 비밀번호 재설정 코드',
    text: [
      '비밀번호 재설정 코드입니다.',
      '',
      `    ${code}`,
      '',
      `앱에서 위 6자리 숫자를 입력하고 새 비밀번호를 설정해주세요. ${minutes}분 동안 유효합니다.`,
      '',
      '본인이 요청하지 않으셨다면 이 메일을 무시하세요.',
      '코드를 입력하지 않으면 비밀번호는 바뀌지 않습니다.',
    ].join('\n'),
  };
}
