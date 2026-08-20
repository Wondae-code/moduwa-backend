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

- **토큰이 없어도 됩니다.** 로그인하지 않은 사용자는 종전대로 `deviceId`로 식별합니다.
- **토큰이 있는데 만료·폐기됐으면 401** (`session_expired`). 이때 `deviceId`로 폴백하지 않습니다 —
  조용히 익명으로 떨어지면 사용자에게는 "내 데이터가 전부 사라졌다"로 보이기 때문입니다.
  앱은 401을 받으면 토큰을 지우고 로그인 화면으로 보내면 됩니다.
- 토큰을 보낸 요청에서는 **`deviceId`가 신원으로 쓰이지 않습니다.** 보내도 되고(구버전 호환),
  안 보내도 됩니다. 보낸 값은 "어느 기기인가"를 기록하는 데만 쓰입니다.

베이스 URL: `https://moduwa-backend-production.up.railway.app`

## 공개 엔드포인트 (인증 불필요)
| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/` | API 개요·엔드포인트 목록 |
| GET | `/health` | 상태 점검 `{status, db}` |

## 계정 (로그인)

이메일 로그인. 애플·구글·카카오·네이버는 아직 붙지 않았다(스키마와 병합 규칙은 준비돼 있다).

### 왜 `deviceId`를 함께 보내야 하나 — **가입/로그인 시 반드시 보내세요**

로그인하기 전에 익명으로 쓴 후기·플랜·저장·게시글이 있습니다. 가입·로그인 요청에 그 기기의
`deviceId`가 들어 있어야 서버가 그것들을 계정으로 **옮겨 줍니다.** 빠뜨리면 익명 데이터가
그대로 남아 사용자에게는 사라진 것처럼 보입니다.

응답의 `merged`가 `true`면 실제로 합쳐진 것이니, 앱에서 "기존에 작성하신 내용을 가져왔습니다"
같은 안내를 띄우면 됩니다.

### POST /v1/auth/email/sign-up — 이메일 가입

| 필드 | 필수 | 설명 |
|---|---|---|
| `email` | ✅ | 이메일. 대소문자 구분 없음(소문자로 저장) |
| `password` | ✅ | 8~128자 |
| `deviceId` | 권장 | 이 기기의 익명 데이터를 계정으로 가져오는 데 쓴다 |
| `nickname` | — | 생략 시 기존 익명 닉네임 유지, 그것도 없으면 `여행자` |

**201**:
```json
{
  "token": "44HSQNBT-B6Y6vc616L1b4LV6rR3fayrjeOHMdtWBEI",
  "expiresAt": "2026-11-18T07:23:47.935Z",
  "author": { "uuid": "f5ee33a7-…", "nickname": "에이", "email": "me@example.com", "emailVerified": false },
  "merged": false,
  "created": true
}
```
- `token`은 **이 응답에서 한 번만** 나옵니다. 서버에 원문이 남지 않아 다시 받을 수 없습니다.
- `emailVerified`는 항상 `false`입니다 — 이메일 인증은 아직 없습니다(아래 참고).

오류: `invalid_email` · `invalid_password` · `invalid_nickname` · **`email_taken`(409)**

### POST /v1/auth/email/sign-in — 로그인

`{email, password, deviceId?}` → 가입과 같은 형태의 **200**.

- 실패는 이유를 구분하지 않고 항상 `invalid_credentials`(401)입니다. 없는 계정과 틀린 비밀번호를
  나눠 주면 그것만으로 가입 여부를 알아낼 수 있기 때문입니다. 응답 시간도 같게 맞춰져 있습니다.
- 같은 IP에서 시도가 잦으면 `too_many_attempts`(429). 10분 창.

### POST /v1/auth/sign-out — 로그아웃

`X-Session-Token` 필수. 본문에 `{deviceId}`를 **함께 보내세요.**

```json
{ "ok": true }
```

토큰을 폐기하고 그 기기의 계정 바인딩을 끊습니다. `deviceId`를 빠뜨리면 토큰만 죽고 기기는
계정에 묶인 채 남아, 로그아웃했는데 계정 데이터가 다시 보입니다.

> **로그아웃한 기기는 빈 상태로 시작합니다.** 계정과 데이터는 서버에 남고 다시 로그인하면
> 돌아오지만, 앱은 로그아웃 직후 저장 탭·플랜 탭을 **비워야** 합니다.

### GET /v1/auth/me — 현재 계정

`X-Session-Token` 필수. 앱 기동 시 저장된 토큰이 아직 유효한지 확인하는 용도.

```json
{ "uuid": "f5ee33a7-…", "nickname": "에이", "email": "me@example.com", "emailVerified": false }
```

만료·폐기된 토큰이면 **401** `session_expired` → 토큰을 지우고 로그인 화면으로.

### 아직 없는 것

- **이메일 인증** — 발송 도메인과 메일 provider가 준비되지 않아 `emailVerified`는 계속 `false`입니다.
- **비밀번호 찾기** — 같은 이유로 없습니다. **지금은 비밀번호를 잊으면 계정 복구 방법이 없습니다.**
- **소셜 로그인** — 애플·구글·카카오·네이버.

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
앱의 핵심 데이터셋. `barrier_free` 대상(관광지·숙박·음식점·축제 등 10,248곳). 사진 보유 → 접근성 정보 보유 → contentid 순으로 정렬한다.

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
  "total": 10248, "limit": 20, "offset": 0, "count": 20,
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

### GET /v1/barrier-free/:contentId — 장소 상세
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

### GET /v1/search — 통합 검색 (검색 페이지용)
무장애 장소(barrier_free) 대상. 이름 부분 일치 + 지역명(주소) 매칭, 관련성 정렬(정확 > 접두 > 부분 > 지역, 동순위는 사진·접근성 정보 보유 우선).

| 파라미터 | 예시 | 설명 |
|---|---|---|
| `q` | `경복궁` | **필수.** 검색어(최대 100자). 없으면 `400 {"error":"missing_q"}` |
| `limit`/`offset` | | 페이지네이션 |

응답:
```json
{
  "total": 2, "limit": 20, "offset": 0, "count": 2,
  "items": [{
    "contentid": "126508", "title": "경복궁",
    "contenttypeid": "12", "category": "관광지",
    "region": "서울 종로구",
    "firstimage": "https://tong.visitkorea.or.kr/...jpg",
    "mapx": 126.9769, "mapy": 37.5796,
    "access": { "wheelchair": true, "visual": true, "hearing": false, "infant": true }
  }]
}
```
- `category`: 콘텐츠유형 라벨(12관광지·14문화시설·15축제공연행사·25여행코스·28레포츠·32숙박·38쇼핑·39음식점)
- `region`: 주소 축약("서울특별시 종로구 …" → "서울 종로구")
- `mapx`/`mapy`: 경도/위도. 목록·상세와 같은 표기이며 원본에 좌표가 없으면 `null`.
  검색 결과를 플랜 일정에 담거나 지도에 찍을 때 쓴다 — 없으면 클라이언트가 상세를 한 번 더 불러야 한다
- `access`: 접근성 배지 — 이동(wheelchair)·시각(visual)·청각(hearing)·영유아(infant) 정보 보유 여부

### GET /v1/barrier-free/:contentId/related — 함께 가볼만한 곳
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
- 무장애 장소 10,248곳 **전부** 3장 이상, 98.5%가 10장을 확보한다. 다만 약 66%가 `nearby` 유래라 `rlte`가 없는 지방 소규모 장소는 추천이 심심할 수 있다
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

작성자 식별은 **세션 토큰이 우선**이고, 없으면 **기기 UUID(`deviceId`) + 닉네임**이다. 같은 `deviceId`로 여러 번 쓰면 작성자(`authors`) 행은 하나만 생기고 재사용된다.

> `X-Session-Token`을 보내면 `deviceId`는 생략할 수 있고, 글은 로그인한 계정에 귀속된다.

| 필드 | 필수 | 설명 |
|---|---|---|
| `deviceId` | ✅ | 기기 UUID(≤128자). **응답에는 절대 포함되지 않는다** — 사실상 신원 토큰 |
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
    "deviceId": "A1B2C3D4-E5F6-4711-8899-AABBCCDDEEFF",
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

### POST /v1/reviews/:reviewId/comments — 댓글 작성
작성자 식별은 리뷰 작성과 **같은 규칙**이다 — 기기 UUID + 닉네임, 처음 쓰는 기기면 `authorNm` 필수.

| 필드 | 필수 | 설명 |
|---|---|---|
| `deviceId` | ✅ | 기기 UUID(≤128자). 응답에 포함되지 않는다 |
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
`invalid_json` · `invalid_body`(객체 아님/길이 초과) · `missing_deviceId` · `invalid_deviceId` · `missing_locationNm` · `invalid_locationNm` · `missing_body` · `invalid_rating` · `invalid_contentId` · `invalid_authorNm` · `missing_authorNm`(처음 쓰는 기기인데 닉네임 없음) · `invalid_imageURLs`

> ⚠️ **운영 주의.** 쓰기 API가 있으므로 `reviews`·`authors`의 소스는 관리형(prod) DB다.
> `scripts/push-data.sh`의 파괴적 동기화 대상에서 두 테이블은 제외되어 있다 — 되돌리면 유저 리뷰가 소실된다.

## 플랜 (여행 일정)

앱의 플랜 탭 데이터. **개인 데이터**라 리뷰와 달리 조회도 소유자로 좁힌다 — 소유자 식별은 리뷰와 같다(세션 토큰 우선, 없으면 `deviceId`).

> 아래 표기의 `?deviceId=`는 **로그인하지 않은 요청에서만 필수**입니다. `X-Session-Token`을 보내면 생략할 수 있습니다.

### GET /v1/plan-options — 새 플랜 플로우 선택지
4/6(테마)·5/6(예산) 화면이 그릴 목록. 사용자별 값이 아니다.
```json
{ "themes": [{ "code": "heritage", "label": "전통과 역사" }, …12개],
  "budgets": [{ "code": "low", "label": "저예산", "hint": "아끼고 싶어요" }, …3개] }
```
표시 문구를 앱에 하드코딩하지 않고 서버가 내려보낸다 — 문구가 바뀔 때 앱 재배포 대신 서버 배포로 끝난다.

### GET /v1/plans?deviceId= — 내 플랜 목록
최근 여행부터. **본문(`days`)은 싣지 않는다** — 목록 카드에 필요 없다.
```json
{ "count": 1, "items": [{
  "id": "…", "title": "경주 2박",
  "startDate": "2026-09-01", "endDate": "2026-09-02",
  "region": "gyeongju", "party": { "ageGroups": ["twenties"] },
  "coverImageURL": null, "createdAt": "…", "updatedAt": "…" }] }
```

### GET /v1/plans/:planId?deviceId= — 플랜 상세
위 필드 + `days[]`. 없는 플랜과 **남의 플랜을 구분해 주지 않는다**(둘 다 404) — 존재 여부가 새어 나갈 이유가 없다.
```json
{ "…": "목록과 동일", "days": [{
  "id": "…", "date": "2026-09-01",
  "items": [
    { "id": "…", "kind": "stop", "place": { "contentID": "126508", "name": "황리단길",
      "categoryLabel": "관광명소", "category": null, "region": "경주시내",
      "imageURL": null, "latitude": 35.83, "longitude": 129.21 } },
    { "id": "…", "kind": "memo", "text": "점심은 여기서" }
  ] }] }
```

### PUT /v1/plans/:planId — 플랜 저장 (생성 + 수정)
`planId`는 **클라이언트가 만든 UUID**다. 생성과 수정이 같은 요청이라 앱이 "새 플랜인지" 따질 필요가 없다.

| 필드 | 필수 | 설명 |
|---|---|---|
| `deviceId` | ✅ | 소유자 식별. 응답에 포함되지 않는다 |
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

### DELETE /v1/plans/:planId?deviceId= — 플랜 삭제
목록 카드의 `⋮` 메뉴가 쓸 자리. 성공 시 **204**(본문 없음). `days`/`items`는 cascade로 함께 지워진다.

- 남의 플랜·없는 플랜 모두 **404** — 조회와 같은 규칙이다(존재 여부를 흘리지 않는다)
- `deviceId` 누락은 400
- ⚠️ **되돌릴 수 없다.** 휴지통을 두지 않은 이유: 플랜은 사용자가 직접 만든 소수의 데이터라 다시 만드는 비용이 크지 않고, 소프트 삭제를 넣으면 목록·상세 조회 전부에 조건이 붙어 실수할 여지가 늘어난다

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
