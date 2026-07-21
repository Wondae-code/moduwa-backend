# moduwa 관광 데이터 API

한국관광공사 TourAPI 기반 관광 데이터 조회 API (읽기 전용).

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
`200` 성공 · `401` 인증 실패 · `404` 없음 · `429` 요청 초과 · `500` 서버오류 · `503` DB 다운

## 데이터 출처·라이선스
한국관광공사 TourAPI (data.go.kr). 표출 시 **출처 표시** 필요. 사진은 `image_copyright`(Type1=변경금지, Type3=출처표시) 준수.
