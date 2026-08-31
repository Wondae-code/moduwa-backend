# moduwa 관광 데이터 API

한국관광공사 TourAPI 기반 관광 데이터 조회 API. 관광 데이터는 읽기 전용이고, **리뷰만 쓰기(POST)가 가능**하다.

## 인증

인증은 **두 층**이고 서로 다른 질문에 답합니다. 섞어 쓰지 마세요.

### ① API 키 — "이 앱이 호출해도 되는가"
모든 `/v1/*` 요청에 필요합니다. 둘 중 하나:
```
Authorization: Bearer <API_KEY>
x-api-key: <API_KEY>
```
키가 없거나 틀리면 **401**. 분당 요청 한도 초과 시 **429**(`Retry-After` 헤더 참고).

### ② 세션 토큰 — "이 요청이 누구인가"
로그인한 사용자의 요청에 함께 보냅니다. **별도 헤더**입니다:
```
X-Session-Token: <SESSION_TOKEN>
```
`/v1/auth/email/sign-in`·`sign-up` 응답의 `token`을 저장해 두고 씁니다.

- **둘러보기는 토큰 없이 됩니다** — 장소 목록·상세·검색, 남의 후기·게시글 읽기.
- **쓰기와 개인 데이터 조회는 토큰이 필수입니다.** 없으면 **401 `login_required`** 입니다.
  앱은 이 응답을 받으면 로그인 창을 띄우면 됩니다.
- **토큰이 있는데 만료·폐기됐으면 401 `session_expired`** 입니다. 두 코드를 구분하세요 —
  `login_required`는 "아직 로그인 안 함", `session_expired`는 "토큰이 낡음"입니다.
- 세션은 쓰는 동안 자동 연장되지만(기본 90일), **생성 후 180일이 지나면 만료**됩니다.
- `sign-in`·`sign-up`은 **낡은 토큰이 헤더에 붙어 있어도 통과**합니다. 그러지 않으면 만료된
  토큰을 지우지 않은 앱이 재로그인조차 못 하게 됩니다.

### 로그인이 필요한 엔드포인트

| | |
|---|---|
| 후기·댓글 | `POST /v1/reviews`, `POST /v1/reviews/:id/comments` |
| 게시글 | `POST /v1/posts`, `DELETE /v1/posts/:id`, 좋아요, `POST /v1/posts/:id/comments` |
| 플랜 | `GET/PUT/DELETE /v1/plans…`, 확정 |
| 저장 | `GET /v1/saved-places`, `PUT/DELETE /v1/saved-places/:contentId` |
| 게시글 목록의 내 것 필터 | `GET /v1/posts?mine=true`, `?liked=true` |

**보는 사람 기준 파생 값.** 게시글(목록·단건·생성·수정)과 댓글(게시글 댓글·후기 댓글) 응답에는
`isMine`이, 게시글과 후기에는 `likedByMe`가 실립니다. 둘 다 **세션이 누구인지**로 계산하고, 비로그인은 둘 다 `false`입니다
(`null`이 아닙니다). `isMine`은 수정·삭제 메뉴를 띄울지 판단하는 값입니다 — 닉네임 비교로
대신하면 동명이인에서 틀립니다.

> ⚠️ **`deviceId`는 더 이상 신원이 아닙니다.** 예전에는 이 값만으로 그 사람이 되어, 값을 아는
> 사람이 남의 데이터를 보거나 대신 글을 쓸 수 있었습니다. 지금 쓰기 라우트는 `deviceId`를
> 아예 읽지 않습니다. 가입·로그인 요청에서만 "어느 기기인가"를 기록하는 데 씁니다.
- 세션은 쓰는 동안 자동 연장되지만(기본 90일), **생성 후 180일이 지나면 만료**됩니다.
- `sign-in`·`sign-up`은 **낡은 토큰이 헤더에 붙어 있어도 통과**합니다. 그러지 않으면 만료된
  토큰을 지우지 않은 앱이 재로그인조차 못 하게 됩니다.

베이스 URL: `https://moduwa-backend-production.up.railway.app`

## 공개 엔드포인트 (인증 불필요)
| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/` | API 개요·엔드포인트 목록 |
| GET | `/health` | 상태 점검 `{status, db}` |

## 계정 (로그인)

이메일 로그인. 애플·구글·카카오·네이버는 아직 붙지 않았다(스키마와 병합 규칙은 준비돼 있다).

### 온보딩 프로필을 함께 보내세요

익명 사용이 없어졌으므로 **서버에는 로그인 계정만 존재합니다.** 온보딩에서 고른 무장애 항목은
앱이 로컬에 갖고 있다가 **가입 요청에 실어 보내면** 계정에 저장됩니다(`accessFeatures`).

`deviceId`는 선택입니다 — 보내면 "이 계정이 이 기기를 쓴다"는 기록만 남습니다.

### POST /v1/auth/email/sign-up — 이메일 가입

| 필드 | 필수 | 설명 |
|---|---|---|
| `email` | ✅ | 이메일. 대소문자 구분 없음(소문자로 저장) |
| `password` | ✅ | 8~128자 |
| `accessFeatures` | — | 온보딩에서 고른 무장애 항목(문자열 배열, 최대 32개). 코드는 앱의 `AccessibilityFeature` rawValue |
| `deviceId` | — | 기기 기록용(≤128자). 신원으로 쓰이지 않는다 |
| `nickname` | — | 생략 시 기존 익명 닉네임 유지, 그것도 없으면 `여행자` |

**201**:
```json
{
  "token": "44HSQNBT-B6Y6vc616L1b4LV6rR3fayrjeOHMdtWBEI",
  "expiresAt": "2026-11-18T07:23:47.935Z",
  "author": {
    "uuid": "f5ee33a7-…", "nickname": "에이",
    "email": "me@example.com", "emailVerified": false,
    "accessFeatures": ["wheelchairAccessible", "elderlyFriendly"],
    "onboarded": true, "avatarUrl": null
  },
  "created": true
}
```
- `token`은 **이 응답에서 한 번만** 나옵니다. 서버에 원문이 남지 않아 다시 받을 수 없습니다.
- `emailVerified`는 가입 직후 `false`입니다. **가입과 동시에 인증 코드 메일이 발송됩니다** —
  앱은 인증 코드 입력 화면으로 이어가면 됩니다(아래 `verify`).
- `accessFeatures`는 **가입할 때만** 반영됩니다. 로그인에서도 덮으면 앱을 지웠다 깐 기기로
  로그인하는 것만으로 사용자가 직접 고친 프로필이 온보딩 기본값으로 되돌아갑니다.
- `onboarded`는 `accessFeatures` 키를 보냈는지로 결정됩니다 — 빈 배열만으로는
  "아무것도 고르지 않았다"와 "온보딩을 안 했다"를 구분할 수 없습니다.

오류: `invalid_email` · `invalid_password` · `invalid_nickname` · **`email_taken`(409)**

### POST /v1/auth/email/sign-in — 로그인

`{email, password, deviceId?}` → 가입과 같은 형태의 **200**. (`accessFeatures`는 무시됩니다 — 위 참고)

- 실패는 이유를 구분하지 않고 항상 `invalid_credentials`(401)입니다. 없는 계정과 틀린 비밀번호를
  나눠 주면 그것만으로 가입 여부를 알아낼 수 있기 때문입니다. 응답 시간도 같게 맞춰져 있습니다.
- 같은 IP에서 시도가 잦으면 `too_many_attempts`(429). 10분 창.

### POST /v1/auth/sign-out — 로그아웃

`X-Session-Token` 필수. **본문은 필요 없습니다.**

```json
{ "ok": true }
```

토큰을 폐기하고, **그 세션이 발급될 때 기록된 기기**의 계정 바인딩을 끊습니다.

> 본문에 `deviceId`를 보내도 **무시됩니다.** 예전에는 그 값을 그대로 믿었는데, 그러면 유효한
> 세션 하나만 가진 사람이 남의 `deviceId`를 넘겨 그 기기를 강제 로그아웃시키고 바인딩까지
> 지울 수 있었습니다. 끊을 기기는 서버가 세션 기록에서 직접 읽습니다.

> **로그아웃한 기기는 빈 상태로 시작합니다.** 계정과 데이터는 서버에 남고 다시 로그인하면
> 돌아오지만, 앱은 로그아웃 직후 저장 탭·플랜 탭을 **비워야** 합니다.

### GET /v1/auth/me — 현재 계정

`X-Session-Token` 필수. 앱 기동 시 저장된 토큰이 아직 유효한지 확인하는 용도.

```json
{
  "uuid": "f5ee33a7-…", "nickname": "에이",
  "email": "me@example.com", "emailVerified": false,
  "accessFeatures": ["wheelchairAccessible"], "onboarded": true,
  "avatarUrl": "https://moduwa.app/images/reviews/ab12….jpg"
}
```

만료·폐기된 토큰이면 **401** `session_expired` → 토큰을 지우고 로그인 화면으로.

### PATCH /v1/auth/me — 무장애 프로필 수정

`X-Session-Token` 필수. `{accessFeatures: string[]}` → 갱신된 계정(위 `/me` 와 같은 모양).

가입 때 한 번 정하고 끝낼 값이 아니다 — 다치거나 회복하거나 아이가 크면 필요한 것이 바뀐다.
온보딩을 건너뛴 사람이 나중에 고르는 경로이기도 하다.

- **빈 배열도 유효한 선택이다**("지금은 필요한 것이 없다"). 이 요청을 부르는 것 자체가
  온보딩을 마쳤다는 뜻이라 `onboarded` 는 `true` 가 되고, 그 뒤로 되돌아가지 않는다.
- 키를 아예 보내지 않으면 **400 `nothing_to_update`** 입니다 — 빈 배열과 구분해야 합니다.
- 값은 검증하지 않습니다(앱이 항목을 늘려도 서버 배포가 필요 없게). 개수 32개·항목 40자 상한만 겁니다.

### PATCH /v1/auth/me — 프로필 편집  🔒

**부분 갱신입니다.** 온 키만 바꾸고, 세 키가 모두 없을 때만 `400 nothing_to_update` 입니다.

```jsonc
{ "nickname": "대원" }                                    // 닉네임만
{ "avatarUrl": "https://…/images/reviews/ab12.jpg" }      // 사진 설정
{ "avatarUrl": null }                                     // 사진 제거
{ "nickname": "대원", "accessFeatures": ["wheelchairAccessible"] }
```

| 필드 | 규칙 |
|---|---|
| `nickname` | 트림 후 1~40자. **빈 문자열은 400** — "지우기"가 아니라 잘못된 입력입니다(`authors.nickname` 은 not null) |
| `avatarUrl` | `https://` 로 시작, ≤300자. **`null` = 제거, 키 없음 = 그대로** |
| `accessFeatures` | 문자열 배열. 빈 배열은 "필요한 것 없음"이라는 유효한 값 |

- 응답은 `AuthorView` 그대로 — 앱이 재조회 없이 화면을 갱신할 수 있습니다.
- **`onboarded` 는 `accessFeatures` 가 실제로 온 경우에만 켜집니다.** 닉네임만 바꾼 것을
  온보딩 완료로 해석하면 앱이 온보딩을 다시 띄울 기회를 잃습니다.
- `http` URL 은 400 입니다 — iOS ATS 가 막아서 저장은 되고 화면에는 안 뜨는 조용한 실패가
  되기 때문입니다.
- 사진 업로드는 기존 `POST /v1/reviews/images` 를 그대로 쓰고, 반환된 URL 을 `avatarUrl` 로
  보내면 됩니다(파일명이 내용의 sha256 이라 경로 접두사가 뜻을 갖지 않습니다).

오류: `invalid_nickname` · `invalid_avatarUrl` · `invalid_accessFeatures` · `nothing_to_update`(전부 400)

### 남이 보는 자리의 프로필 — `authorInfo`

**기존 `author` 문자열은 그대로 둡니다**(iOS 라이브 사용). 프로필은 `authorInfo` 로 덧붙습니다.

```jsonc
// 후기 목록·상세, 후기 댓글
"author": "대원",
"authorInfo": { "nickname": "대원", "reviewCount": 3, "level": 7,
                "avatarUrl": "https://…" }

// 게시글 목록·상세, 게시글 댓글 (reviewCount·level 없음)
"author": "대원",
"authorInfo": { "nickname": "대원", "avatarUrl": "https://…" }
```

`avatarUrl` 이 `null` 이면 사진이 없는 것입니다 — 앱은 이니셜 원을 그립니다.
`author_id` 가 없는 레거시 후기도 `null` 입니다.

### POST /v1/auth/email/verify/request — 인증 코드 재발송

`X-Session-Token` 필수. 가입 시 자동으로 한 번 보내지만, 못 받았을 때 이걸로 다시 받습니다.

```json
{ "ok": true }
```

- 이미 인증된 계정이면 `{ "ok": true, "alreadyVerified": true }` (메일을 보내지 않습니다)
- 60초 안에 다시 부르면 **429** `resend_too_soon` (`retryAfter` 초 포함)

### POST /v1/auth/email/verify — 이메일 인증

`X-Session-Token` 필수. `{code}` — 메일로 받은 **6자리 숫자**.

```json
{ "ok": true, "emailVerified": true }
```

### POST /v1/auth/email/forgot — 비밀번호 찾기

`{email}` → **항상 200**, 항상 같은 응답입니다.

```json
{ "ok": true, "message": "가입된 주소라면 재설정 코드를 보냈습니다." }
```

> ⚠️ **가입 여부를 알려주지 않습니다.** 없는 주소, 형식이 틀린 주소, 소셜로만 가입한 계정
> 모두 같은 응답입니다. 응답이 갈리면 그것만으로 이메일 열거가 되고, 그 목록이 곧 무차별
> 대입 대상이 됩니다. 재발송 간격 제한(60초)에 걸려도 조용히 200입니다.

### POST /v1/auth/email/reset — 비밀번호 재설정

`{email, code, password}` — `code`는 메일로 받은 6자리 숫자.

```json
{ "ok": true, "message": "비밀번호가 변경되었습니다. 다시 로그인해주세요." }
```

> **성공하면 그 계정의 모든 세션이 끊깁니다.** 계정을 되찾는 상황은 남이 들어와 있을 수
> 있다는 뜻이고, 비밀번호만 바꾸고 그 사람의 세션을 살려 두면 되찾은 게 아닙니다.
> 앱은 재설정 후 로그인 화면으로 보내야 합니다.

### 코드 관련 오류

| 코드 | 상태 | 뜻 |
|---|---|---|
| `invalid_code` | 400 | 틀린 코드. **없는 이메일도 같은 응답**입니다(열거 방지) |
| `code_expired` | 400 | 만료(기본 10분). 다시 받아야 합니다 |
| `code_attempts_exceeded` | 429 | 한 코드에 5회 실패 → 그 코드는 폐기. 다시 받아야 합니다 |
| `resend_too_soon` | 429 | 60초 안에 재발송 요청 |

> 6자리 숫자는 100만 가지라 찍어서 맞출 수 있습니다. 그것을 막는 것은 자릿수가 아니라
> **코드별 5회 제한**입니다. 계정을 잠그지는 않습니다 — 그러면 남의 계정을 잠글 수 있습니다.

### POST /v1/auth/google · /v1/auth/apple · /v1/auth/kakao — 소셜 로그인

**가입과 로그인이 한 라우트다.** 소셜은 계정이 있는지를 사용자가 알 필요가 없다 —
처음 온 신원이면 계정을 만들고 **201**, 있던 신원이면 **200**. 응답 모양은 이메일과 같다.

| 필드 | 필수 | 설명 |
|---|---|---|
| `idToken` | ✅ | 프로바이더가 준 ID 토큰(JWT) |
| `deviceId` | — | 기기 기록용. 신원으로 쓰이지 않는다 |
| `accessFeatures` | — | 온보딩 항목. 이메일 가입과 같이 **계정을 만들 때만** 반영된다 |
| `nickname` | — | **애플용.** 애플은 이름을 토큰에 담지 않고 최초 인증 응답에서만 주므로, 앱이 그때 받은 이름을 여기 싣는다. 새 계정의 초기 닉네임으로만 쓰인다. 구글(`name`)·카카오(`nickname`)는 토큰에 들어 있어 보내지 않아도 된다 |

- 서버는 토큰의 **서명·발급자·만료**를 프로바이더 JWKS 로 검증하고, `aud` 가 **우리 앱의
  클라이언트 ID**인지 확인합니다.

  | 프로바이더 | `aud` 에 들어오는 값 | 환경변수 |
  |---|---|---|
  | 구글 | iOS 클라이언트 ID · 웹 클라이언트 ID(안드로이드용) | `GOOGLE_CLIENT_IDS` |
  | 애플 | 앱 번들 ID (웹은 Service ID) | `APPLE_CLIENT_IDS` |
  | 카카오 | **앱 키** — SDK 는 네이티브 앱 키, REST 는 REST API 키 | `KAKAO_APP_KEYS` |

  > ⚠️ `aud` 검사가 핵심입니다. 서명만 보면 **남의 앱에 발급된 토큰**으로도 로그인이 됩니다
  > (그 사람으로 로그인됩니다). 그래서 클라이언트 ID 가 설정되지 않은 프로바이더는
  > 통과시키지 않고 **503 `social_not_configured`** 로 거부합니다.
- 프로바이더가 `email_verified` 를 참으로 주면 그 계정의 이메일도 인증된 것으로 표시합니다 —
  그러지 않으면 구글로 가입한 사람에게 앱이 영원히 "이메일 인증 전"을 띄웁니다.
- 계정은 **`(provider, subject)`** 로 정합니다. 같은 이메일이라는 이유로 기존 계정에 붙이지
  않습니다 — 이메일 소유를 검증하지 않는 프로바이더가 섞이면 그것만으로 계정 탈취가 됩니다.
- 애플은 이메일을 **최초 1회만** 줍니다. 계정 대표 이메일은 비어 있을 때만 채우므로
  두 번째 로그인에서 `null` 이 와도 지워지지 않습니다.

#### 카카오에서 특히 주의할 것

- **개발자 콘솔에서 OpenID Connect 를 켜야 합니다.** 켜지 않으면 앱이 받는 것은
  `access_token` 뿐이고 `idToken` 이 아예 없습니다. 앱에서는 로그인이 성공한 것처럼 보이는데
  서버에 보낼 토큰이 없는 상태라, **"로그인은 되는데 서버가 토큰이 없다고 한다"** 는 대부분
  이 문제입니다. 앱은 `openid` 스코프도 함께 요청해야 합니다.
- **`aud` 는 클라이언트 ID 가 아니라 앱 키입니다.** 구글과 개념이 다릅니다.
- **카카오 이메일은 인증된 것으로 표시하지 않습니다.** 카카오 ID 토큰에는 `email_verified` 에
  해당하는 클레임이 없고(공식 디스커버리 문서로 확인), 카카오계정에는 미인증 이메일이 존재할
  수 있습니다. 확인되지 않은 주소를 인증 표시하면 그 표시가 거짓이 되므로, 우리 이메일
  인증(6자리 코드)으로 확인받습니다.
- 이메일은 사용자가 `account_email` 동의를 해야 옵니다. 동의하지 않으면 `null` 입니다.

오류: `missing_idToken`(400) · `invalid_token`(401) · `social_not_configured`(503) · `too_many_attempts`(429)

### 아직 없는 것

- **네이버 로그인** — 스키마와 계정 처리는 준비돼 있습니다(검증 함수만 늘리면 됩니다).
- **웹 재설정 페이지** — 지금은 앱에서 코드를 입력받는 방식입니다. 웹이 생기면 링크를
  병행할 수 있습니다(같은 테이블을 그대로 씁니다).

## 데이터 엔드포인트

### GET /v1/pet-friendly — 반려동물 동반 가능 관광지 (9,767곳)
쿼리 파라미터(모두 선택):

| 파라미터 | 예시 | 설명 |
|---|---|---|
| `region` | `11` | 법정동 시도코드(2자리) |
| `sigungu` | `110` | 법정동 시군구코드(3자리) |
| `type` | `12` | 콘텐츠유형(12관광지·14문화·28레포츠·32숙박·38쇼핑·39음식) |
| `petArea` | `전구역 동반가능` | 동반 구역(`전구역 동반가능`/`일부구역 동반가능`) |
| `guideDog` | `true` | 안내견/보조견 동반 가능만 |
| `q` | `공원` | 이름 부분검색 |
| `limit` | `20` | 페이지 크기(1~100, 기본 20) |
| `offset` | `0` | 시작 위치 |

응답:
```json
{
  "total": 9767, "limit": 20, "offset": 0, "count": 20,
  "items": [{
    "contentid": "1019041", "title": "와룡공원", "contenttypeid": "12",
    "addr1": "서울특별시 종로구 와룡공원길 192",
    "mapx": 126.99, "mapy": 37.59,
    "firstimage": "http://tong.visitkorea.or.kr/...jpg",
    "pet_allowed": true,
    "pet_area": "전구역 동반가능", "pet_species": "전 견종 동반 가능", "pet_need": "목줄 착용",
    "pet_etc": "...", "guide_dog_allowed": false,
    "overview": "...", "usetime": "상시 개방"
  }]
}
```
> `pet_*` = 일반 반려동물 동반 / `guide_dog_allowed` = 장애인 보조견 동반(무장애 데이터). **서로 다른 개념**이니 배지도 따로.

### GET /v1/pet-friendly/:contentId — 단건
```
GET /v1/pet-friendly/1019041
```
없으면 404.

### GET /v1/attractions — 지역 대표 관광지 상세 (54,478곳)
| 파라미터 | 예시 | 설명 |
|---|---|---|
| `sigungu` | `11110` | 시군구코드 |
| `source` | `tourapi` | 정보출처(`tourapi`/`kakao`/`map-only`) |
| `q` | `해수욕장` | 이름 부분검색 |
| `limit`/`offset` | | 페이지네이션 |

응답 아이템 주요 필드: `hub_tats_nm`(이름), `map_x/map_y`(좌표), `map_url_kakao`·`map_url_naver`(지도 딥링크, 100%), `overview`·`usetime`(소개·운영시간), `phone`·`category`·`place_url`(카카오), `firstimage`(사진), `detail_source`.

### GET /v1/attractions/:hubTatsCd — 단건

### GET /v1/barrier-free — 무장애 여행 장소 목록

**접근성 그룹 필터** — `access=wheelchair,visual,hearing,infant,elderly` (콤마 구분).

**AND 다.** 휠체어도 필요하고 유아 동반도 하는 사람에게 둘 중 하나만 되는 곳은 갈 수 있는
곳이 아니다. OR 로 두면 휠체어(9,270곳)가 결과를 삼켜 필터가 무의미해진다.

| 그룹 | 뜻 | 전국 | 관광지 | 맛집 | 숙소 | 축제 |
|---|---|---|---|---|---|---|
| `wheelchair` | 이동 약자 | 9,270 | 3,126 | 2,490 | 971 | 6 |
| `visual` | 시각 | 3,431 | 1,315 | 466 | 252 | 5 |
| `hearing` | 청각 | **107** | 27 | 22 | 23 | 0 |
| `infant` | 영유아 | 3,000 | 878 | 1,076 | 264 | 0 |
| `elderly` | 고령자 | 6,231 | — | — | — | — |

> ⚠️ **청각은 원본 데이터가 얇다.** 이 필터를 걸면 목록이 서너 페이지에 바닥나고 축제는
> 아예 비어 있다. 채워 넣지 않는다 — 무장애 앱에서 없는 것을 있는 것처럼 보여 주는 것이
> 가장 나쁜 거짓말이다. 앱은 이 사실을 프로필 화면에서 미리 알린다.

**정렬도 함께 바뀐다.** 조건을 걸면 **고른 축의 충실도**(그 그룹 속성이 몇 개나 채워졌는지)가
첫 정렬 키가 되고, 같은 충실도면 사진 있는 곳 → 전체 속성 수 순이다.

> ⚠️ 이게 없으면 **필터가 동작해도 첫 페이지가 그대로다.** 기본 정렬이 28속성 전체 개수라,
> 속성을 가장 많이 채운 대형 시설은 어느 그룹 조건에도 걸려 어떤 부분집합에도 남는다 —
> 숙소에서 후보가 1,060 → 190 으로 줄어도 상위 6곳이 한 곳도 바뀌지 않았다(2026-08-22 측정).
> 사용자에게는 필터가 고장난 것으로 보인다.

> **모르는 이름은 조용히 무시한다**(400 이 아니다). 앱이 서버보다 먼저 항목을 늘릴 수 있는데
> 그때 400 을 주면 홈 화면 전체가 빈다. 필터가 하나 덜 걸리는 편이 낫다.

> **`elderly` 는 관광공사 5번째 공식 유형이다.** 예전 문서에 "원본에 그 축이 없다" 고 적혀
> 있었는데 틀린 말이었다 — 컬럼 이름에 elder 가 없었을 뿐 데이터는 `wheelchair` 에 있었다.
> 판정 기준은 **휠체어 대여 · 이동보조기기 대여 · 승강기 · 주차 중 하나라도**(037).
> 공식 2항목만 쓰면 14.5% 에 그치는데, 대부분의 고령 여행자는 휠체어를 쓰지 않고 실제로 겪는
> 문제는 계단과 걷는 거리라 승강기·주차를 함께 본다.

앱의 핵심 데이터셋. `barrier_free` 대상(관광지·숙박·음식점·축제 등 10,265곳). 사진 보유 → 접근성 정보 보유 → contentid 순으로 정렬한다.

| 파라미터 | 예시 | 설명 |
|---|---|---|
| `type` | `12` | 콘텐츠유형(12관광지·14문화시설·15축제공연행사·25여행코스·28레포츠·32숙박·38쇼핑·39음식점) |
| `region` | `11` | 법정동 시도코드(`ldong_regn_cd`, 2자리) |
| `sigungu` | `110` | 법정동 시군구코드(`ldong_signgu_cd`, 3자리) |
| `q` | `경복궁` | 이름 부분 일치(`ilike`) |
| `hasImage` | `true` | 대표사진 보유만 |
| `hasAccess` | `true` | 접근성 정보 보유만 |
| `sort` | `access` | 정렬 방식(아래) |
| `seed` | `42` | `sort=random`일 때만 의미 있음 |
| `limit`/`offset` | | 페이지네이션(limit 기본 20, 최대 100) |

**정렬(`sort`)**

| 값 | 동작 |
|---|---|
| `access` (기본) | 무장애 28속성 중 **채워진 개수가 많은 순**. 접근성 정보가 풍부한 장소를 우선 노출한다 |
| `random` | `seed` 기준 의사난수 순. **같은 seed면 항상 같은 순서**라 페이지를 넘겨도 목록이 흔들리지 않는다 |
| `id` | `contentid` 오름차순 (구 동작 복원용) |

> 2026-08-08에 기본 정렬이 `id`류에서 `access`로 바뀌었다. 구 기본값은 `has_image desc, has_access desc, contentid`였는데, 호출부가 `hasImage`/`hasAccess`를 필터로 이미 걸면 앞의 두 키가 결과 집합 안에서 상수가 되어 **사실상 `contentid` 순 고정**이었다. 앱 홈 피드의 "맞춤 추천"이 언제나 같은 장소만 보여주던 원인이다.
> 어느 정렬이든 마지막 키는 `contentid`로 고정되므로 offset 페이지네이션은 안정적이다.

응답은 `{total, limit, offset, count, sort, items}`. item은 DB 컬럼을 그대로 내려보내는 **snake_case**다:

```json
{
  "total": 10265, "limit": 20, "offset": 0, "count": 20,
  "items": [{
    "contentid": "126508", "title": "경복궁", "contenttypeid": "12",
    "addr1": "서울특별시 종로구 사직로 161", "addr2": "",
    "mapx": "126.9769930325", "mapy": "37.5760836609",
    "firstimage": "https://tong.visitkorea.or.kr/...jpg", "firstimage2": "...",
    "ldong_regn_cd": "11", "ldong_signgu_cd": "110",
    "parking": "장애인 전용 주차구역 있음(주차장 3면)", "route": "...", "restroom": "...",
    "braileblock": null, "helpdog": "안내견 동반 가능", "signguide": null, "stroller": "유모차 대여 가능",
    "has_image": true, "has_access": true
  }]
}
```

**무장애 28개 속성은 boolean이 아니라 자유 텍스트다.** 채워져 있으면 시설 설명, `null`이면 정보 미제공이라는 뜻이다. 필드별 의미와 장애 유형별 그룹(지체·공통 이동 12 / 시각 8 / 청각 4 / 영유아 4)은 → **[docs/barrier-free-detail-fields.md](barrier-free-detail-fields.md)**

> ⚠️ 이 라우트와 아래 상세 라우트는 `access` 요약 객체를 내려보내지 **않는다.** 클라이언트가 28개 텍스트 필드를 직접 그룹핑해야 한다. 배지용 boolean 요약(`access.wheelchair` 등)이 필요하면 `/v1/search` 와 `/v1/barrier-free/:contentId/related` 응답에 들어 있다.

### GET /v1/barrier-free/:contentId

**`kakaoPlaceUrl`** — 카카오맵 **장소 상세** 링크(`https://place.map.kakao.com/…`). 좌표 링크는
핀만 찍혀 리뷰·사진·길찾기로 이어지지 않으므로 이 값을 우선 여세요.
매칭된 곳이 **8,567 / 10,266(83%)** 이고, 없으면 `null` 이라 좌표 링크로 폴백하면 됩니다.

> **이미지·링크 URL 은 서버가 `https` 로 올려 보냅니다.** 원본이 http 인 것이 섞여 있어
> (TourAPI 이미지 http 3,999 · https 4,237 / 카카오 링크는 전부 http) iOS ATS 가 막아
> 사진이 조용히 안 뜨는 문제가 있었습니다. 앱에서 다시 처리할 필요 없습니다.
> 목록·검색·관련장소 응답에도 같은 정규화가 적용됩니다.
 — 장소 상세
목록과 같은 필드에 `kor_detail`을 조인해 개요·홈페이지·전화·기본정보를 덧붙인다. 없는 `contentId`는 `404 {"error":"not_found"}`.

```json
{
  "contentid": "126508", "title": "경복궁", "…": "목록과 동일한 필드 전체",
  "overview": "경복궁은 조선 왕조 제일의 법궁이다. …",
  "homepage": "https://www.royalpalace.go.kr",
  "tel": "02-3700-3900",
  "basicInfo": { "usetime": "09:00~18:00", "restdate": "화요일", "parking": "가능", "fee": null }
}
```
- `overview`/`homepage`/`tel`은 원문에서 HTML 태그·엔티티를 정리해 내려보낸다(`homepage`는 `<a href>`에서 URL만 추출)
- `basicInfo`는 TourAPI `detailIntro2`의 **타입별로 다른 필드**를 공통 스키마로 정규화한 것이다 — 숙박(32)은 입실/퇴실을 `usetime`으로, 음식점(39)은 `opentimefood`/`restdatefood`, 축제(15)는 공연시간이 없으면 행사기간으로 대체하고 `fee`에 요금을 담는다
- ⚠️ **커버리지 주의**: `kor_detail`은 관광지(12) 위주로 수집돼 있다. 숙박·음식점·축제는 `overview`/`basicInfo`가 `null`인 경우가 많으므로 클라이언트는 값이 없는 섹션을 숨겨야 한다

### GET /v1/search — 통합 검색 (관련성 정렬)

`q=` 필수(≤100자). 이름과 주소를 함께 찾습니다.

**띄어쓰기와 기호를 무시합니다.** "경 복궁"·"황리단 길"도 잡힙니다 — 검색어와 색인 양쪽을
같은 규칙(소문자·한글/영숫자만)으로 정규화해 비교합니다.

**오타를 허용합니다.** "경북궁"→경복궁, "아꾸아리움"→아쿠아리움. 한글을 **자모로 분해**해
(경복궁=ㄱㅕㅇㅂㅗㄱㄱㅜㅇ) 트라이그램 유사도를 재는 방식이라, 받침 하나 차이가 아홉 자 중
한 자 차이로 계산됩니다. 음절 그대로 재면 이 오타는 잡히지 않습니다(한 글자가 통째로 바뀌므로).

**정렬은 계층이 먼저입니다**: 이름 정확 일치 → 접두 → 부분 → 주소 부분 → 오타 추정.
오타 추정 결과는 정확 일치 위로 올라오지 못하고, 유사도 점수는 같은 계층 안의 순서만
정합니다. 임계값·가중치는 `recommend_weights`의 `search.*` 키로 배포 없이 조정합니다.

응답 항목: `contentid`·`title`·`category`·`region`·`firstimage`·`mapx/mapy`·`access`(5유형).
### GET /v1/barrier-free/:contentId/related

> **`rank` 를 그대로 따라 정렬하세요.** `source`(`rlte`/`nearby`)는 유래를 알려주는 참고값이지
> 품질 순서가 아닙니다. 앱에서 `rlte` 를 위로 올리면 서버 판단을 뒤집게 됩니다 —
> 실제로 `rlte` 쪽이 더 멀고(중위 6.7km vs 근접 2.5km) 유형도 덜 맞았습니다.
> 두 계약(`source`·`rank`)은 계속 유지됩니다.
 — 함께 가볼만한 곳
장소 상세 하단 캐러셀용. `related_places`(018)에 미리 계산해 둔 연관 장소를 `rank` 순으로 반환한다.
추천은 전부 무장애 장소(`barrier_free`) 안에 있어 카드를 누르면 `/v1/barrier-free/:contentId` 상세로 이어진다.

| 파라미터 | 기본 | 설명 |
|---|---|---|
| `limit` | 10 | 1~100. 캐러셀은 10장으로 충분하다 |

응답:
```json
{
  "contentId": "126508", "limit": 10, "count": 10,
  "items": [{
    "contentId": "2762588", "title": "월정교",
    "region": "경북 경주시", "addr1": "경북 경주시 교촌안길 27-11",
    "imageURL": "https://tong.visitkorea.or.kr/...jpg",
    "category": "관광지", "hasAccess": true,
    "access": { "wheelchair": true, "visual": false, "hearing": false, "infant": true },
    "rank": 1, "source": "rlte"
  }]
}
```
- `source`: 추천 유래 — `rlte`(한국관광데이터랩 연관관광지, 실제 동반방문 코스) / `nearby`(같은 시군구·같은 타입 근접) / `nearby_region`(시군구에 짝이 없어 광역 확장) / `nearby_national`(최후 수단). 품질 편차를 계량하기 위해 그대로 내려보낸다
- 무장애 장소 10,265곳 **전부** 3장 이상, 98.5%가 10장을 확보한다. 다만 약 66%가 `nearby` 유래라 `rlte`가 없는 지방 소규모 장소는 추천이 심심할 수 있다
- 파생 테이블이므로 `barrier_free`를 갱신하면 낡는다 → 로컬에서 018 재실행 후 `push-data.sh`

## 리뷰 (여행자 후기)

TourAPI에 없는 자체 데이터. 홈 피드 '여행자 리뷰' 섹션과 장소 상세 '리뷰' 섹션에서 쓴다.

### GET /v1/reviews — 리뷰 목록
| 파라미터 | 예시 | 설명 |
|---|---|---|
| `sort` | `likes` | `recommended`(기본, 좋아요+댓글 순) / **`likes`(좋아요만)** / `latest`(최신순) |
| `contentId` | `2465063` | 특정 장소의 리뷰만. 없으면 전역 목록 |
| `hasImage` | `true` | 사진이 있는 후기만 — 화면의 "사진/영상 후기만 보기" |
| `limit`/`offset` | | 페이지네이션 |

> `likes`와 `recommended`를 같은 것으로 취급하지 말 것. 화면의 "좋아요 순"은 `likes`다. `recommended`는 댓글 수까지 더해 정렬하므로 순서가 다르게 나온다.

응답:
```json
{
  "total": 2, "limit": 20, "offset": 0, "sort": "likes", "count": 2,
  "items": [{
    "id": 2,
    "contentId": "2465063",
    "location": "강릉 녹색도시체험센터",
    "author": "도현",
    "body": "실내 전시라 휠체어로 전 구역 이동이 편했고 …",
    "rating": 5,
    "wouldRevisit": true,
    "likeCount": 88, "commentCount": 15,
    "isAccessibilityVerified": true,
    "imageURLs": ["https://tong.visitkorea.or.kr/...jpg"],
    "createdAt": "2026-07-11T11:13:12Z",
    "authorInfo": { "nickname": "도현", "reviewCount": 1, "level": 2 },
    "tags": [
      { "code": "barrier_free", "label": "무장애 친화적이에요", "shortLabel": "무장애", "icon": "access_wheelchair" },
      { "code": "kids", "label": "아이와 함께하기 좋아요", "shortLabel": "키즈", "icon": "access_child" }
    ]
  }]
}
```
- `rating`: 별점 1~5. **`null` 가능** — 별점 이전에 작성된 리뷰(텍스트 전용)
- `wouldRevisit`: 재방문 의향. **`true`/`false`/`null`(미응답) 세 상태다.** 유저가 직접 고른 값만 들어가며 **별점에서 파생하지 않는다** — 별점이 높아도 멀거나 비싸서 안 갈 수 있고 그 반대도 가능하다
- `tags`: 후기 뱃지용. 뱃지에는 `shortLabel`("무장애"), 칩·집계에는 `label`("무장애 친화적이에요")을 쓴다. 태그가 없으면 `[]`
- `author`: 레거시 표시용 닉네임 문자열. iOS가 라이브로 쓰고 있어 유지된다
- `authorInfo`: 작성자 프로필 — `nickname`, `reviewCount`(해당 작성자의 총 리뷰 수)
  - `level`: **저장하지 않고 `reviewCount`에서 파생.** 임계값 1·3·6·10·20·50·100 (0건=1, 1\~2건=2, 3\~5건=3, 6\~9건=4, 10\~19건=5, 20\~49건=6, 50\~99건=7, 100건+=8)
- `contentId`: 연결된 장소. 자유 방문지면 `null`
- `isAccessibilityVerified`: ♿ 검증 뱃지. 현재 쓰기 API로는 설정되지 않고 항상 `false`

### GET /v1/reviews/summary — 장소 단위 전체 평점
장소 상세 헤더의 "★ 4.3 · 후기 235"용.

| 파라미터 | 예시 | 설명 |
|---|---|---|
| `contentId` | `2465063` | **필수.** 없으면 `400 {"error":"missing_contentId"}` |

```json
{
  "contentId": "2465063", "avgRating": 4.5, "reviewCount": 2, "ratedCount": 2,
  "tags": [
    { "code": "barrier_free", "label": "무장애 친화적이에요", "shortLabel": "무장애", "icon": "access_wheelchair", "count": 21 },
    { "code": "parking", "label": "주차가 편해요", "shortLabel": "주차", "icon": null, "count": 20 }
  ]
}
```
- `avgRating`: 평균 별점(소수 1자리). **`rating`이 `null`인 리뷰는 평균에서 제외된다.** 별점이 하나도 없으면 `null`
- `reviewCount`: 전체 후기 수(별점 없는 것 포함) — 화면의 "후기 N"에 쓴다
- `ratedCount`: 그중 별점이 있는 수 = `avgRating`의 모집단. `reviewCount`와 다를 수 있다
- `tags`: 태그 집계 막대용. **인원 많은 순**으로 정렬되며 태그가 없으면 `[]`
  - ⚠️ 기획의 "20명 이상 언급만 노출" 임계값은 **서버에서 적용하지 않는다.** 개발 단계에서 20명을 채울 수 없어 막대가 전부 사라지기 때문이다. 노출 기준은 클라이언트가 정한다

### GET /v1/review-tags — 후기 태그 카탈로그
후기 작성 화면의 "어떤 점이 좋았나요?" 칩 목록. 파라미터 없음.

```json
{
  "count": 8,
  "items": [
    { "code": "barrier_free", "label": "무장애 친화적이에요", "shortLabel": "무장애", "icon": "access_wheelchair" },
    { "code": "pet", "label": "반려동물과 함께하기 좋아요", "shortLabel": "반려동물", "icon": null }
  ]
}
```
- **카탈로그가 DB(`review_tag_defs`)에 있어 문구·순서·아이콘을 바꿔도 앱 재배포가 필요 없다.** `sql/019`의 insert가 `on conflict do update`라 마이그레이션 재실행으로 반영된다
- `icon`: 앱 에셋 이름. **`null`이면 아직 브랜드 아이콘이 없다는 뜻** — 클라이언트는 텍스트만 렌더해야 한다(현재 반려동물·가성비·친절·주차가 `null`)
- 이 태그는 무장애 28속성과 **성격이 다르다.** 저쪽은 관광공사가 준 사실이고 이쪽은 방문자의 주관 평가다. 화면에서 섞어 표시하지 말 것

### POST /v1/reviews — 리뷰 작성
`Content-Type: application/json`. 인증은 다른 `/v1/*`와 동일(Bearer API 키).

**🔒 로그인 필수.** 작성자는 세션의 계정이고, 글은 그 계정에 귀속된다.

`authorNm`은 **선택**이다 — 보내면 계정 닉네임을 갱신하고, 생략하면 기존 닉네임을 그대로 쓴다.
로그인 계정에는 가입 시 정해진 닉네임이 항상 있으므로 "처음 쓰는 기기" 같은 개념이 없다.

| 필드 | 필수 | 설명 |
|---|---|---|
| `locationNm` | ✅ | 표시용 장소명(≤200자) |
| `rating` | ✅ | 1~5 **정수**(숫자 타입). 소수·문자열은 400 |
| `body` | ✅ | 본문(공백만이면 400, ≤2000자) |
| `authorNm` | 조건부 | 닉네임(≤40자). 처음 쓰는 기기면 필수, 이미 아는 기기면 생략 시 기존 닉네임 재사용(보내면 갱신) |
| `contentId` | | 연결할 장소(≤64자). 생략하면 자유 방문지 |
| `tags` | | 태그 `code` 문자열 배열(최대 8개, 중복은 자동 제거). **카탈로그에 없는 code는 400** — 조용히 버리면 사용자가 고른 태그가 사라진 이유를 알 수 없다 |
| `wouldRevisit` | | 재방문 의향 `true`/`false`. **생략하면 `null`(미응답)로 저장되고 서버가 별점으로 추측하지 않는다.** boolean 아닌 값은 400 |
| `imageURLs` | | 사진 URL 문자열 배열. 최대 5장, `http(s)`만. 업로드 자체는 이 API 범위 밖 |

```bash
curl -X POST "$BASE/v1/reviews" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{
    "contentId": "2465063",
    "locationNm": "강릉 녹색도시체험센터",
    "rating": 4,
    "body": "엘리베이터가 넓어 휠체어로 층 이동이 편했습니다.",
    "authorNm": "바다",
    "tags": ["barrier_free", "parking"],
    "wouldRevisit": true,
    "imageURLs": ["https://example.com/photo1.jpg"]
  }'
```
태그는 리뷰와 **같은 트랜잭션**에서 저장된다 — 후기만 남고 태그가 빠지는 상태는 생기지 않는다.

### GET /v1/reviews/:reviewId/comments — 댓글 목록
리뷰 상세의 댓글. **대화 순서(오래된 순)** 로 반환한다. 없는 `reviewId`는 `404 {"error":"not_found"}`.

```json
{
  "reviewId": 2, "total": 3, "limit": 20, "offset": 0, "count": 3,
  "items": [{
    "id": 3, "author": "민지",
    "body": "실내라 비 오는 날에도 좋겠네요. 정보 감사합니다!",
    "createdAt": "2026-08-06T04:13:13Z",
    "authorInfo": { "nickname": "민지", "reviewCount": 1, "level": 2 }
  }]
}
```

### PUT · DELETE /v1/reviews/:reviewId/like — 후기 좋아요  🔒

게시글 좋아요와 같은 규칙. 멱등이다(PUT 두 번 눌러도 +1, 없는 좋아요 DELETE 도 200).

```json
{ "reviewId": 1, "likedByMe": true, "likeCount": 43 }
```

- 목록·상세 응답의 `likedByMe` 는 **보는 사람(세션)** 기준이다 — 비로그인이면 전부 false.
- `likeCount` 는 `reviews.like_count` 컬럼이다. 시연 시드값을 버리지 않고 그 위에 ±1 누적한다
  (post_likes 처럼 0 부터 세면 시드 좋아요가 사라지고 '좋아요 순' 정렬 인덱스도 못 쓴다).
- 오류: `invalid_reviewId`(400) · `not_found`(404) · `login_required`(401)

### PATCH · DELETE /v1/reviews/:reviewId/comments/:commentId — 후기 댓글 수정·삭제  🔒
`PATCH {body}` → 200(갱신된 댓글), `DELETE` → **204**. **본인 것만** 됩니다.

- 남의 것·없는 것·형식이 틀린 id 모두 **404**입니다(403이 아닙니다 — 앱 분기가 하나로 끝나고 존재 여부도 새지 않습니다)
- 검증은 작성과 같습니다. 빈 `body`는 400 — 수정이 두 번째 삭제 경로가 되지 않게 합니다
- 하드 삭제입니다(대댓글이 없어 남길 맥락이 없습니다). 되돌릴 수 없습니다
- ⚠️ 삭제는 `reviews.comment_count`를 **같은 트랜잭션에서 -1** 합니다. 목록의 `commentCount`와 `sort=recommended`가 이 카운터를 읽으므로, 줄이지 않으면 후기 카드의 댓글 수가 실제보다 많아집니다. 남의 것을 지우려다 404가 난 경우에는 줄지 않습니다

### POST /v1/reviews/:reviewId/comments — 댓글 작성
작성자 식별은 리뷰 작성과 **같은 규칙**이다 — 기기 UUID + 닉네임, 처음 쓰는 기기면 `authorNm` 필수.

| 필드 | 필수 | 설명 |
|---|---|---|
| `body` | ✅ | 댓글 내용(공백만이면 400, ≤1000자) |
| `authorNm` | 조건부 | 닉네임(≤40자). 처음 쓰는 기기면 필수 |

201로 생성된 댓글 한 건을 목록과 같은 형태로 반환한다.

- **`reviews.comment_count`를 같은 트랜잭션에서 함께 올린다.** 댓글은 늘었는데 화면의 댓글 수만 그대로인 상태를 만들지 않는다
- 카운터가 어긋나면 `npm run migrate`가 실제 댓글 수로 복구한다(`sql/020`의 마지막 update가 멱등)
- ⚠️ 시드 리뷰의 `comment_count`는 원래 근거 없는 숫자(7·15·4·23·9·18·3)였다. 020에서 **실제 댓글 수로 덮었다** — "댓글 23"이 뜨는데 목록엔 2건만 나오는 상태를 없애기 위함이다
- 댓글 수정·삭제 라우트는 없다

### POST /v1/reviews/images — 후기 사진 업로드
`multipart/form-data`, 필드명 **`files`**(반복 가능). 작성 완료 **전에** 올려서 앱이 썸네일을 미리 보여줄 수 있게 한다. 응답의 `url`을 그대로 `POST /v1/reviews`의 `imageURLs`에 넣으면 된다.

| 제한 | 값 |
|---|---|
| 장당 크기 | **2MB** |
| 요청 전체 | **10MB** |
| 장수 | 5장 |
| 포맷 | JPEG · PNG · HEIC |

```bash
curl -X POST "$BASE/v1/reviews/images" \
  -H "Authorization: Bearer $KEY" \
  -F "files=@photo1.jpg" -F "files=@photo2.jpg"
```
```json
{
  "count": 1,
  "items": [{
    "url": "https://…/images/reviews/d20f6ffd…13ab.jpg",
    "bytes": 284310, "type": "image/jpeg"
  }]
}
```

- **서버는 리사이즈하지 않는다.** 클라이언트가 **장변 1280px · JPEG q0.8**로 줄여서 올린다. 앱에서 사진을 가장 크게 쓰는 곳이 393×260pt(3x에서 약 1179px)라 그 이상은 저장할 이유가 없다. 서버에서 줄이려면 `sharp` 같은 네이티브 의존성이 필요하고, 클라이언트에서 줄이면 업로드도 빨라지며 **재인코딩 과정에서 GPS 등 EXIF가 사라지는** 이점까지 따라온다
- 2MB 상한은 위 규격 실제 크기(200~450KB)의 4~5배다. 정상 업로드를 막지 않으면서 방어선 역할만 한다
- **파일명은 내용의 sha256.** 같은 사진을 두 번 올려도 한 번만 저장되고 URL도 같다
- **확장자·Content-Type을 믿지 않고 실제 바이트(매직 넘버)로 판별**한다. 텍스트 파일을 `.jpg`로 올리면 400
- 저장소(Railway 볼륨 `/data`)에 쓸 수 없으면 **503**. 컨테이너 임시 파일시스템에 조용히 쓰면 재배포 때 사진이 사라지므로 일부러 드러낸다
- ⚠️ 볼륨에만 존재하고 **백업이 없다.** 시연 자료로 쓸 사진이면 따로 보관할 것

### GET /images/reviews/:name — 업로드된 사진 (인증 불필요)
**`/v1/*`가 아니라 공개 경로다.** iOS `AsyncImage`는 `Authorization` 헤더를 붙이지 않아 인증 경로에 두면 이미지가 전부 401이 된다. 후기 사진은 앱에 공개로 노출되는 콘텐츠이고, 파일명이 sha256이라 URL을 모르면 접근할 수 없다.

- `Cache-Control: public, max-age=31536000, immutable` — 내용이 곧 이름이라 같은 URL의 내용은 절대 바뀌지 않는다
- 이름이 `[0-9a-f]{64}.(jpg|png|heic)` 형식이 아니면 404. 경로 조작(`../`)은 이 검사에서 막힌다
**201** + 생성된 리뷰 1건(GET 목록 item과 같은 형태, `authorInfo` 포함):
```json
{
  "id": 15, "contentId": "2465063", "location": "강릉 녹색도시체험센터",
  "author": "바다", "body": "엘리베이터가 넓어 …", "rating": 4,
  "likeCount": 0, "commentCount": 0, "isAccessibilityVerified": false,
  "imageURLs": ["https://example.com/photo1.jpg"],
  "createdAt": "2026-08-08T12:10:29Z",
  "authorInfo": { "nickname": "바다", "reviewCount": 1, "level": 2 }
}
```
검증 실패는 **400** + `{"error": "...", "message": "..."}`:
`invalid_json` · `invalid_body`(객체 아님/길이 초과) · **`login_required`(401)** · `missing_locationNm` · `invalid_locationNm` · `missing_body` · `invalid_rating` · `invalid_contentId` · `invalid_authorNm` · `invalid_imageURLs`

> ⚠️ **운영 주의.** 쓰기 API가 있으므로 `reviews`·`authors`의 소스는 관리형(prod) DB다.
> `scripts/push-data.sh`의 파괴적 동기화 대상에서 두 테이블은 제외되어 있다 — 되돌리면 유저 리뷰가 소실된다.

## 플랜 (여행 일정)

앱의 플랜 탭 데이터. **개인 데이터**라 조회도 소유자로 좁힌다.

> **🔒 이 절의 모든 엔드포인트는 로그인 필수**입니다(`plan-options` 제외). 소유자는 세션의 계정입니다.

### GET /v1/plan-options — 새 플랜 플로우 선택지
4/6(테마)·5/6(예산) 화면이 그릴 목록. 사용자별 값이 아니다.
```json
{ "themes": [{ "code": "heritage", "label": "전통과 역사" }, …12개],
  "budgets": [{ "code": "low", "label": "저예산", "hint": "아끼고 싶어요" }, …3개] }
```
표시 문구를 앱에 하드코딩하지 않고 서버가 내려보낸다 — 문구가 바뀔 때 앱 재배포 대신 서버 배포로 끝난다.

### POST /v1/plans/recommend — AI 추천 코스  🔒

기획팀 명세("AI 추천 코스 로직") v1. **플랜을 저장하지 않습니다** — 제안만 돌려주고, 사용자가
고르면 앱이 기존 `PUT /v1/plans/:planId` 로 저장합니다.

| 필드 | 필수 | 설명 |
|---|---|---|
| `region` 또는 `regionCode` | ✅ | 슬러그(`gangneung`) 또는 `ldong_regn_cd`(`51`). 슬러그 목록은 `region_slugs` |
| `sigunguCode` | | `regionCode`와 함께 쓸 때 시군구까지 좁힘 |
| `startDate`/`endDate` | ✅ | `YYYY-MM-DD`, **최대 14일** |
| `party` | | `kids`·`pet`·`elderly`·`couple`·`friends`·`solo` |
| `themes` | | `GET /v1/plan-options`의 테마 코드. 목록 밖은 **400** |
| `budget` | | `low`·`medium`·`high` — 숙소 가격대 |
| `dayTripOnly` | | `true`면 숙소를 고르지 않음 |
| `avoidCrowds` | | `true`면 혼잡일 회피를 **더 세게** 반영. 미전송·`false`는 기존 동작 그대로 |

```json
{
  "region": "강릉",
  "stay": { "contentID": "…", "name": "세인트존스 호텔", "imageURL": "…" },
  "days": [{
    "date": "2026-09-01", "congestion": 27.7, "busy": false,
    "items": [
      { "slot": "meal_morning", "contentID": "…", "name": "…", "categoryLabel": "음식점",
        "imageURL": "…", "latitude": 37.79, "longitude": 128.91,
        "hasAccessInfo": true }
    ]
  }],
  "notes": []
}
```

**하루 템플릿(`slot`)** — 명세 3번: `meal_morning` · `spot` · `meal_lunch` · `spot` · `spot` · `cafe` · `meal_dinner` · `spot`

식사 자리는 카카오 세부 분류로 시간대를 맞춥니다 — 아침엔 해장국·죽·베이커리, 저녁엔
고기·해물 쪽이 올라옵니다. 어긋나도 **거르지는 않고 점수만 밉니다**(후보가 적은 지역에서
거르면 칸이 통째로 빕니다). 하루 안에서 같은 유형이 반복되면 감점하고, 같은 이름의 장소는
코스 전체에서 한 번만 나옵니다.

**`notes`** — 결과가 어떻게 조정됐는지 앱이 안내 문구를 띄우는 근거입니다.

| 값 | 뜻 |
|---|---|
| `budget_fallback` | 고른 가격대에 숙소가 없어 인접 가격대로 확장 |
| `budget_ignored` | 그래도 없어 가격대 없이 골랐음 — **배지를 숨기고 안내 문구 필요** |
| `no_congestion_data` | 여행일이 혼잡도 예측 범위 밖 (현재 약 2.5개월치만 보유) |
| `thin_pool` | 후보가 적어 일부 슬롯이 비었음 |
| `includes_unsurveyed` | 무장애 조사를 받지 않은 식당·카페가 섞였음 (아래 참고) |

**오류**: `missing_region` · `unknown_region`(400) · `no_candidates`(404, 그 지역에 후보 없음) · `invalid_date` · `invalid_themes` · `invalid_budget`

> **`congestion`은 4곳 중 1곳만 값이 있습니다.** 혼잡도는 이름+시군구로만 우리 장소와
> 이어지는데 전국 "기준 관광지"가 6,574곳뿐이라 음식점·쇼핑·숙박은 대상이 아닙니다.
> **없으면 중립**으로 다루고 불이익을 주지 않습니다(`hub_rank`도 같은 24% 커버리지).

#### `hasAccessInfo` — 무장애 조사 여부

**`false`는 "접근성이 나쁘다"가 아니라 "모른다"입니다.** 무장애 조사를 받지 않은 곳입니다.

소도시는 무장애 등록 식당만으로 일정을 채울 수 없습니다. 가평은 볼거리가 20곳인데 등록
식당이 **1곳**이라 2박 일정의 아홉 끼를 채울 수 없었습니다(실측). 그래서 **식사·카페 자리에
한해** 국문관광정보의 음식점까지 후보로 씁니다 — 가평 기준 1곳 → 78곳.

- **볼거리·숙소에는 섞이지 않습니다.** 그쪽은 부족하지 않고, 접근성을 모르는 곳을 코스
  전반에 섞으면 앱의 약속이 무너집니다.
- **조사된 곳이 먼저 쓰입니다.** 모자란 만큼만 채웁니다. 강릉·서울은 `hasAccessInfo: false`가
  하나도 나오지 않습니다.
- 코스에 하나라도 섞이면 `notes`에 `includes_unsurveyed`가 붙습니다.

> ⚠️ **앱은 `hasAccessInfo: false`인 카드에 조사되지 않았음을 표시해야 합니다.** 조용히 섞으면
> 사용자가 조사된 곳으로 오해하고, 그것이 무장애 앱에서 가장 나쁜 거짓말입니다.

> **경로 안내는 v1에 없습니다.** 하루 안의 순서는 직선거리로 뭉치고, 카카오 Directions는
> 확정된 일정에만 붙일 예정입니다(v2). 그때도 **자동차 경로**라 도보 안내가 아님을 UI에
> 표시해야 합니다.

### GET /v1/plans — 내 플랜 목록
최근 여행부터. **본문(`days`)은 싣지 않는다** — 목록 카드에 필요 없다.
```json
{ "count": 1, "items": [{
  "id": "…", "title": "경주 2박",
  "startDate": "2026-09-01", "endDate": "2026-09-02",
  "region": "gyeongju", "party": { "ageGroups": ["twenties"] },
  "coverImageURL": null, "createdAt": "…", "updatedAt": "…" }] }
```

### GET /v1/plans/:planId — 플랜 상세
위 필드 + `days[]`. 없는 플랜과 **남의 플랜을 구분해 주지 않는다**(둘 다 404) — 존재 여부가 새어 나갈 이유가 없다.
```json
{ "…": "목록과 동일", "days": [{
  "id": "…", "date": "2026-09-01",
  "items": [
    { "id": "…", "kind": "stop", "place": { "contentID": "126508", "name": "황리단길",
      "categoryLabel": "관광명소", "category": null, "region": "경주시내",
      "imageURL": null, "latitude": 35.83, "longitude": 129.21,
      "hasAccessInfo": true } },
    { "id": "…", "kind": "memo", "text": "점심은 여기서" }
  ] }] }
```

> **`place.hasAccessInfo` 는 읽기 전용입니다.** 저장 요청에 실을 필요가 없고, 보내도 무시합니다.
> 서버가 `contentID` 로 매번 도출합니다 — 정의 자체가 "무장애 조사 대상에 있는가" 이기 때문입니다.
> 컬럼에 굳히지 않는 이유는 두 가지입니다: ① 이미 저장된 플랜도 값을 갖게 되고
> ② 관광공사가 나중에 그 장소를 조사하면 자동으로 `true` 로 바뀝니다(굳히면 "정보 없음" 이
> 영구히 박힙니다). **`false` 는 "접근 불가" 가 아니라 "모른다" 입니다.**

### PUT /v1/plans/:planId — 플랜 저장 (생성 + 수정)
`planId`는 **클라이언트가 만든 UUID**다. 생성과 수정이 같은 요청이라 앱이 "새 플랜인지" 따질 필요가 없다.

| 필드 | 필수 | 설명 |
|---|---|---|
| `title` | ✅ | ≤60자 |
| `startDate`/`endDate` | ✅ | `YYYY-MM-DD`. 종료일이 앞서면 400 |
| `authorNm` | 조건부 | 처음 저장하는 기기면 필수 |
| `region`/`party`/`coverImageURL` | | `party`는 앱이 해석하는 jsonb |
| `themes` | | 테마 `code` 배열. 목록 밖 코드는 **400** — 고른 것이 조용히 사라지지 않게 |
| `budget` | | `low`/`medium`/`high`. **생략하면 `null`(고르지 않음)** — 기본값을 넣지 않는다 |
| `dayTripOnly` | | 4/6 하단 "당일치기만 즐길게요". 날짜로 유추하지 않는다 — 하루짜리 일정과 당일치기 선호는 다른 값이다 |
| `days[]` | | `{id?, date, items[]}` · item은 `{id?, kind:'stop'\|'memo', place?, text?}` |

- **본문(days/items)은 통째로 교체된다.** 편집 화면에서 순서 바꾸기·장소 추가·메모가 한꺼번에 일어나므로, 부분 갱신 API를 여러 개 두면 클라이언트가 호출 순서를 맞추다 중간 상태가 저장된다. 한 트랜잭션에 다 넣으면 그럴 일이 없다
- 남의 플랜을 덮어쓰려 하면 **403**. 검증 실패 시 트랜잭션이 통째로 롤백돼 기존 데이터가 남는다
- 하루 수 60일 · 하루 항목 60개 상한
- **이동 거리는 저장하지 않는다.** 좌표만 있으면 계산할 수 있고, 저장하면 순서를 바꿀 때마다 갱신해야 하는데 그 갱신을 반드시 어딘가에서 빠뜨린다

### 플랜 공동 편집 — 초대와 멤버

플랜 소유자가 초대 코드를 발급해 공유하면, 받은 사람이 **편집자**로 참여해 함께 고칩니다.
역할은 둘뿐입니다 — 소유자(삭제·초대·강퇴)와 편집자(조회·편집·나가기).

#### POST /v1/plans/:planId/invites — 초대 코드 발급  🔒 소유자

```json
{ "code": "QAJG3G4R",
  "inviteUrl": "https://moduwa.app/i/QAJG3G4R",
  "expiresAt": "…", "expiresInMinutes": 30 }
```

- `inviteUrl`은 **유니버설 링크**입니다. 앱이 있으면 바로 앱이 열리고, 없으면 대체 페이지가
  코드와 스토어 안내를 보여줍니다. 카톡 인앱 웹뷰 등에서는 링크가 앱을 못 열 수 있는데,
  그때도 대체 페이지가 받으므로 치명적이지 않습니다(플랫폼 특성).
- **재발급하면 이전 코드는 회수됩니다** — 플랜당 활성 코드 하나. "링크 회수"가 재발급 한 번입니다.
- 30분 뒤 만료. 링크는 단톡방에 남으므로 앱은 만료 안내와 재발급을 쉽게 해주세요.

#### POST /v1/plan-invites/accept — 초대 수락  🔒

`{code}` — 하이픈·소문자 섞여도 됩니다(`wkq3-m8dz` OK). **코드는 소비되지 않습니다** —
단톡방 하나로 여럿이 들어오는 게 정상 시나리오라, 만료·회수·정원(10명)이 통제 장치입니다.

```json
{ "planId": "…", "title": "강릉 공동 여행", "myRole": "editor", "alreadyMember": false }
```

오류: `invalid_code`(400) · `invite_expired`(400 — "새 코드를 요청해주세요" 안내) ·
`member_limit`(409, 소유자 포함 10명)

#### DELETE /v1/plans/:planId/invites — 초대 회수  🔒 소유자
#### DELETE /v1/plans/:planId/members/:uuid — 강퇴 / 나가기  🔒

소유자는 아무 멤버나, 편집자는 자기 자신(`uuid` = 내 uuid)만 지울 수 있습니다.
소유자 자신은 못 나갑니다(`owner_cannot_leave`) — 주인 없는 플랜을 만들지 않기 위해서입니다.

#### 함께 바뀐 것

- `GET /v1/plans` — 초대받은 플랜도 함께 옵니다. 항목마다 `myRole`(`owner`/`editor`).
- `GET /v1/plans/:planId` — 멤버면 조회됩니다. `version`·`myRole`·`members[]`(uuid·nickname·role) 추가.
- 편집자가 삭제·초대를 시도하면 **403 `owner_only`** 입니다(404가 아닙니다 — 멤버는 플랜의
  존재를 이미 알고, 404를 주면 앱이 목록에서 지워버립니다).

#### ⚠️ PUT 의 낙관적 잠금 — 공동 편집의 핵심

저장은 본문 **통째 교체**라, 버전 검사가 없으면 늦게 저장한 멤버가 먼저 저장한 멤버의 작업을
**소리 없이 되돌립니다.** 그래서:

1. 조회 응답의 `version`을 저장 요청에 그대로 실어 보냅니다
2. 그 사이 다른 멤버가 저장했으면 **409 `version_conflict`** + `latest`(최신 본문 전체)가 옵니다
3. 앱은 "다른 멤버가 방금 수정했어요" 안내 후 `latest`로 화면을 갈아끼우고, 사용자가 다시
   고쳐 저장하게 합니다

`version` 없이 저장하면 — 혼자 쓰는 플랜은 지금처럼 동작하고(구버전 앱 호환), **공유 플랜은
400 `version_required`** 입니다. 공유에 참여하려면 어차피 새 앱이 필요하므로, 구버전 앱이
공유 플랜을 덮어쓰는 조합 자체가 생기지 않습니다.

### DELETE /v1/plans/:planId — 플랜 삭제
목록 카드의 `⋮` 메뉴가 쓸 자리. 성공 시 **204**(본문 없음). `days`/`items`는 cascade로 함께 지워진다.

- 남의 플랜·없는 플랜 모두 **404** — 조회와 같은 규칙이다(존재 여부를 흘리지 않는다)
- 로그인하지 않으면 401 `login_required`
- ⚠️ **되돌릴 수 없다.** 휴지통을 두지 않은 이유: 플랜은 사용자가 직접 만든 소수의 데이터라 다시 만드는 비용이 크지 않고, 소프트 삭제를 넣으면 목록·상세 조회 전부에 조건이 붙어 실수할 여지가 늘어난다

## 푸시 알림 (APNs)

### POST /v1/devices — 기기 토큰 등록  🔒
알림 권한을 받은 직후, 그리고 **로그인할 때마다** 부른다. 성공 시 **204**(본문 없음).

| 필드 | 필수 | 설명 |
|---|---|---|
| `token` | ✅ | APNs 기기 토큰(hex 32~200자). 형식이 다르면 400 `invalid_token` |
| `environment` | ✅ | `sandbox`(Xcode 빌드) 또는 `production`(TestFlight·앱스토어). 다르면 400 `invalid_environment` |
| `platform` | | 기본 `ios` |
| `bundleId` | | 진단용 |

- ⚠️ **`environment`를 필수로 막았다.** 반대쪽 게이트웨이로 보내면 애플이 `BadDeviceToken`으로 **조용히** 거절해서, 이 값이 없으면 왜 안 오는지 진단조차 못 한다
- 토큰이 PK라 재등록은 upsert이고 **`author_id`까지 갱신**한다 — 한 기기를 다른 계정으로 로그인하면 소유자가 바뀌어야 한다. 안 그러면 로그아웃한 사람에게 알림이 계속 간다
- 서버가 `BadDeviceToken`(400)이나 `Unregistered`(410)를 받으면 그 토큰을 지운다. 앱이 따로 정리할 필요는 없다

### DELETE /v1/devices/:token — 해제  🔒
로그아웃·알림 스위치 끄기에서 부른다. 성공 시 **204**.

- **없는 토큰도 204**다(멱등) — 이미 없는 것을 지우는 요청에 오류를 줄 이유가 없다
- 남의 토큰은 지워지지 않는다(소유자 조건)

### 발송되는 알림
`title`은 세 알림 모두 `모두와`이고, 화면 이동에 쓸 값은 `data`에 있다.

| 계기 | `body` | `data` | `thread-id` |
|---|---|---|---|
| 내 글에 좋아요 | `{닉네임}님이 회원님의 글을 좋아합니다` | `type: "post_like"`, `postId` | `post:{postId}` |
| 내 글에 댓글 | `{닉네임}님이 댓글을 남겼어요: {본문 40자}` | `type: "post_comment"`, `postId` | `post:{postId}` |
| 내 플랜에 합류 | `{닉네임}님이 '{플랜명 20자}'에 합류했어요` | `type: "plan_member_joined"`, `planId` | `plan:{planId}` |

`data`의 값은 모두 **문자열**이다(`postId: "12"`). 잠금화면에 그대로 보이므로 인용한 본문은
40자에서 `…`로 자르고, 플랜명은 20자에서 자른다.

규칙:
- **자기 행동에는 알림이 없다** — 자기 글에 자기 좋아요·자기 댓글, 소유자가 자기 초대 링크를 여는 경우
- **좋아요는 같은 사람·같은 글에 24시간 1회**다. 껐다 켜기를 반복해도 한 번만 간다
- **합류는 실제로 새로 들어왔을 때만** 간다. 이미 멤버인 사람의 재수락은 알림이 없고 응답이 `alreadyMember: true`다
- **뱃지(`aps.badge`)를 넣지 않는다.** 서버가 "안 읽은 수"를 모르는 동안 0을 보내면 뱃지가 지워지고, 임의의 수를 보내면 실제와 어긋난다. 알림 목록 API가 생기면 그때 넣는다
- 알림 실패는 원 요청을 깨뜨리지 않는다 — 좋아요가 500이 되면 사용자는 자기 행동이 실패한 것으로 본다

## 예제
```bash
KEY=mdw_xxx
BASE=https://moduwa-backend-production.up.railway.app

# 서울에서 전구역 반려동물 동반 가능한 곳
curl -H "Authorization: Bearer $KEY" \
  "$BASE/v1/pet-friendly?region=11&petArea=전구역 동반가능&limit=5"

# 반려견도 안내견도 되는 곳
curl -H "Authorization: Bearer $KEY" "$BASE/v1/pet-friendly?guideDog=true"

# '해수욕장' 이름 검색 (지역 대표)
curl -H "Authorization: Bearer $KEY" "$BASE/v1/attractions?q=해수욕장&limit=10"
```
```javascript
const res = await fetch(`${BASE}/v1/pet-friendly?region=11&limit=20`, {
  headers: { Authorization: `Bearer ${KEY}` },
});
const { total, items } = await res.json();
```

## 상태 코드
`200` 성공 · `201` 생성됨(POST /v1/reviews) · `400` 잘못된 요청(필수 파라미터·검증 실패) · `401` 인증 실패 · `404` 없음 · `429` 요청 초과 · `500` 서버오류 · `503` DB 다운

## 데이터 출처·라이선스
한국관광공사 TourAPI (data.go.kr). 표출 시 **출처 표시** 필요. 사진은 `image_copyright`(Type1=변경금지, Type3=출처표시) 준수.
