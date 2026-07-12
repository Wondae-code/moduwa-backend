# 신청·승인된 공공데이터 API 카탈로그

data.go.kr 마이페이지(활용신청 현황)에서 직접 탐색으로 수집 (2026-06-29). 모두 **개발계정·승인**,
**인증키 공용**(`.env`의 `DATA_GO_KR_SERVICE_KEY`), 각 서비스/오퍼레이션은 **독립 일일 트래픽**.

| # | API | 기관 | 엔드포인트 | 비고 |
|---|---|---|---|---|
| 1 | 식품_관광식당 조회서비스 | 행안부 | `https://apis.data.go.kr/1741000/tourist_restaurants` | 일 10,000 |
| 2 | 지역별 관광 다양성 | KTO | `https://apis.data.go.kr/B551011/AreaTarDivService` | 통계 |
| 3 | 관광지별 연관 관광지 정보 ✅수집중 | KTO | `https://apis.data.go.kr/B551011/TarRlteTarService1` | 구현됨 |
| 4 | 기초지자체 중심 관광지 정보 | KTO | `https://apis.data.go.kr/B551011/LocgoHubTarService1` | 시군구 기반 |
| 5 | 국문 관광정보 서비스 (KorService2) | KTO | `https://apis.data.go.kr/B551011/KorService2` | **전국 POI 종합** |
| 6 | 빅데이터_지역별 방문자수 | KTO | `https://apis.data.go.kr/B551011/DataLabService` | 시계열 |
| 7 | 무장애 여행 정보 (KorWithService2) | KTO | `https://apis.data.go.kr/B551011/KorWithService2` | KorService2 동일구조 |
| 8 | 관광지 집중률 방문자 추이 예측 | KTO | `https://apis.data.go.kr/B551011/TatsCnctrRateService` | 향후 30일 예측 |

## 오퍼레이션

**1. 식품_관광식당** (`/1741000/tourist_restaurants`)
- `/info` 데이터 조회 (매일 갱신, 2일전 기준) · `/history` 이력조회 (2026.01.01~)

**2. 지역별 관광 다양성** (`AreaTarDivService`)
- `/areaTouDivList` 관광객 다양성(연령별 방문객수)
- `/areaExpDivList` 소비 다양성(연령별 신용카드 소비액)
- `/areaIntlDivList` 국제적 다양성

**4. 기초지자체 중심 관광지** (`LocgoHubTarService1`)
- `/areaBasedList1` 시군구 기반 중심 관광지 목록 (※ 연관관광지와 유사 구조)

**5. 국문 관광정보 KorService2** (`KorService2`) — 15개 오퍼레이션
- 목록: `/areaBasedList2`(지역기반·전국 POI), `/locationBasedList2`(위치기반), `/searchKeyword2`(키워드), `/searchFestival2`(축제), `/searchStay2`(숙박), `/areaBasedSyncList2`(동기화)
- 상세: `/detailCommon2`(공통:개요·주소·좌표), `/detailIntro2`(소개:운영시간 등), `/detailInfo2`(반복), `/detailImage2`(이미지), `/detailPetTour2`(반려동물)
- 코드: `/ldongCode2`(법정동), `/lclsSystmCode2`(분류체계), `/areaCode2`·`/categoryCode2`(폐지예정)

**6. 빅데이터_지역별 방문자수** (`DataLabService`)
- `/metcoRegnVisitrDDList` 광역 지자체 방문자수(일별) · `/locgoRegnVisitrDDList` 기초 지자체 방문자수(일별)

**7. 무장애 여행 KorWithService2** (`KorWithService2`) — KorService2와 동일 구조 + `/detailWithTour2`(무장애 상세)

**8. 관광지 집중률 예측** (`TatsCnctrRateService`)
- `/tatsCnctrRatedList` 관광지별 향후 30일 관광객 집중률

## 공통 호출 규약 (TourAPI/KTO)
- 필수: `serviceKey`, `MobileOS`(ETC), `MobileApp`, `_type=json`, `numOfRows`, `pageNo`
- 응답(구형): `response.header.resultCode`(정상 `0000`/`0`) + `response.body.items.item[]` + `totalCount`
- 응답(에러, 신형): 플랫 JSON `{resultCode:"11", resultMsg:"NO_MANDATORY_REQUEST_PARAMETERS_ERROR1(xxx)"}`
- 한도초과: XML 봉투 `<returnReasonCode>22</returnReasonCode>`

## 실측 확정 파라미터 (2026-06-29)
| API / 오퍼레이션 | 필수 추가 파라미터 | 규모/패턴 | 응답 주요필드 |
|---|---|---|---|
| KorService2 `/areaBasedList2` | (없음) | 전국 **50,700**, 페이지네이션 | contentid, contenttypeid, title, addr1/2, areacode, sigungucode, cat1/2/3, mapx, mapy, tel, firstimage, lDongRegnCd, lclsSystm1/2/3, modifiedtime |
| KorWithService2 `/areaBasedList2` | (없음) | 전국 **9,956** | 〃 (무장애 POI) |
| LocgoHubTarService1 `/areaBasedList1` | `baseYm`, `areaCd`, `signguCd` | 시군구×월 (원주 100) | baseYm, hubTatsCd, hubTatsNm, areaCd, signguCd, mapX, mapY, hubCtgryLclsNm, hubCtgryMclsNm, hubRank |
| DataLab `/metcoRegnVisitrDDList` | `startYmd`, `endYmd` (YYYYMMDD) | 시도×일×관광객유형 | areaCode, areaNm, baseYmd, daywkDivCd/Nm, touDivCd/Nm(현지인/외지인/외국인), touNum |
| DataLab `/locgoRegnVisitrDDList` | `startYmd`, `endYmd` | 시군구×일×유형 (3일 2,376) | signguCode, signguNm, baseYmd, daywkDiv*, touDiv*, touNum |
| TatsCnctrRateService `/tatsCnctrRatedList` | `areaCd`, `signguCd` | 시군구별 향후 30일 (원주 1,650) | baseYmd, areaCd, signguCd, tAtsNm, cnctrRate |
| AreaTarDivService `/areaTouDivList`·`/areaExpDivList`·`/areaIntlDivList` | `areaCd`, `baseYm` | ⚠️ 전 조합 0건(120개 검증) — 제공기관 데이터 **미개방**. 크롤러는 완성(`ingest:areadiv`, 프로브 가드로 데이터 개방 시 자동 수집) | - |

- 인증키 공용, 각 서비스 일일 트래픽 독립.
- 법정동 코드체계(areaCd 2자리 시도, signguCd 5자리). 시군구 목록은 [src/sigungu-codes.json](../src/sigungu-codes.json) 재사용.
