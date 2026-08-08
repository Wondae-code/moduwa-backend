# moduwa 관광 데이터 API

한국관광공사 TourAPI 기반 관광 데이터 조회 API. 관광 데이터는 읽기 전용이고, **리뷰만 쓰기(POST)가 가능**하다.

## 인증
모든 `/v1/*` 요청에 발급받은 API 키가 필요합니다. 둘 중 하나:
```
Authorization: Bearer <API_KEY>
x-api-key: <API_KEY>
```
키가 없거나 틀리면 **401**. 분당 요청 한도 초과 시 **429**(`Retry-After` 헤더 참고).

베이스 URL: `https://moduwa-backend-production.up.railway.app`

## 공개 엔드포인트 (인증 불필요)
| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/` | API 개요·엔드포인트 목록 |
| GET | `/health` | 상태 점검 `{status, db}` |

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
    "access": { "wheelchair": true, "visual": true, "hearing": false, "infant": true }
  }]
}
```
- `category`: 콘텐츠유형 라벨(12관광지·14문화시설·15축제공연행사·25여행코스·28레포츠·32숙박·38쇼핑·39음식점)
- `region`: 주소 축약("서울특별시 종로구 …" → "서울 종로구")
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
| `sort` | `latest` | `recommended`(기본, 좋아요+댓글 순) / `latest`(최신순) |
| `contentId` | `2465063` | 특정 장소의 리뷰만. 없으면 전역 목록 |
| `limit`/`offset` | | 페이지네이션 |

응답:
```json
{
  "total": 2, "limit": 20, "offset": 0, "count": 2,
  "items": [{
    "id": 2,
    "contentId": "2465063",
    "location": "강릉 녹색도시체험센터",
    "author": "도현",
    "body": "실내 전시라 휠체어로 전 구역 이동이 편했고 …",
    "rating": 5,
    "likeCount": 88, "commentCount": 15,
    "isAccessibilityVerified": true,
    "imageURLs": ["https://tong.visitkorea.or.kr/...jpg"],
    "createdAt": "2026-07-11T11:13:12Z",
    "authorInfo": { "nickname": "도현", "reviewCount": 1, "level": 2 }
  }]
}
```
- `rating`: 별점 1~5. **`null` 가능** — 별점 이전에 작성된 리뷰(텍스트 전용)
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
{ "contentId": "2465063", "avgRating": 4.5, "reviewCount": 2, "ratedCount": 2 }
```
- `avgRating`: 평균 별점(소수 1자리). **`rating`이 `null`인 리뷰는 평균에서 제외된다.** 별점이 하나도 없으면 `null`
- `reviewCount`: 전체 후기 수(별점 없는 것 포함) — 화면의 "후기 N"에 쓴다
- `ratedCount`: 그중 별점이 있는 수 = `avgRating`의 모집단. `reviewCount`와 다를 수 있다

### POST /v1/reviews — 리뷰 작성
`Content-Type: application/json`. 인증은 다른 `/v1/*`와 동일(Bearer API 키).

로그인 체계가 없으므로 작성자는 **기기 UUID(`deviceId`) + 닉네임**으로 식별한다. 같은 `deviceId`로 여러 번 쓰면 작성자(`authors`) 행은 하나만 생기고 재사용된다.

| 필드 | 필수 | 설명 |
|---|---|---|
| `deviceId` | ✅ | 기기 UUID(≤128자). **응답에는 절대 포함되지 않는다** — 사실상 신원 토큰 |
| `locationNm` | ✅ | 표시용 장소명(≤200자) |
| `rating` | ✅ | 1~5 **정수**(숫자 타입). 소수·문자열은 400 |
| `body` | ✅ | 본문(공백만이면 400, ≤2000자) |
| `authorNm` | 조건부 | 닉네임(≤40자). 처음 쓰는 기기면 필수, 이미 아는 기기면 생략 시 기존 닉네임 재사용(보내면 갱신) |
| `contentId` | | 연결할 장소(≤64자). 생략하면 자유 방문지 |
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
    "imageURLs": ["https://example.com/photo1.jpg"]
  }'
```
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
