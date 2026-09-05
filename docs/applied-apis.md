# 신청·승인된 공공데이터 API 카탈로그

data.go.kr 마이페이지(활용신청 현황)에서 직접 탐색으로 수집 (2026-06-29). 모두 **개발계정·승인**,
**인증키 공용**(`.env`의 `DATA_GO_KR_SERVICE_KEY`), 각 서비스/오퍼레이션은 **독립 일일 트래픽**.

| # | API | 기관 | 엔드포인트 | 비고 |
|---|---|---|---|---|
| 1 | 식품_관광식당 조회서비스 ✅수집중 | 행안부 | `https://apis.data.go.kr/1741000/tourist_restaurants` | 일 10,000 · `ingest:restaurants` |
| 2 | 지역별 관광 다양성 | KTO | `https://apis.data.go.kr/B551011/AreaTarDivService` | 통계 |
| 3 | 관광지별 연관 관광지 정보 ✅수집중 | KTO | `https://apis.data.go.kr/B551011/TarRlteTarService1` | 구현됨 |
| 4 | 기초지자체 중심 관광지 정보 | KTO | `https://apis.data.go.kr/B551011/LocgoHubTarService1` | 시군구 기반 |
| 5 | 국문 관광정보 서비스 (KorService2) | KTO | `https://apis.data.go.kr/B551011/KorService2` | **전국 POI 종합** |
| 6 | 빅데이터_지역별 방문자수 | KTO | `https://apis.data.go.kr/B551011/DataLabService` | 시계열 |
| 7 | 무장애 여행 정보 (KorWithService2) | KTO | `https://apis.data.go.kr/B551011/KorWithService2` | KorService2 동일구조 |
| 8 | 관광지 집중률 방문자 추이 예측 ✅수집중 | KTO | `https://apis.data.go.kr/B551011/TatsCnctrRateService` | 향후 30일 예측 |
| 9 | 반려동물 동반여행 (KorPetTourService2) ✅수집중 | KTO | `https://apis.data.go.kr/B551011/KorPetTourService2` | `ingest:pet`·`ingest:pet-detail` |

## 활용 현황 (2026-09-04 실측)

| # | API | 수집 스크립트 | 적재 |
|---|---|---|---|
| 1 | 식품_관광식당 | `ingest:restaurants` | 사업장 **218**곳(영업중 142) |
| 2 | AreaTarDivService | (수집 안 함) | **0건** — 데이터는 있으나 수집하지 않기로 결정, 아래 ⚠️ 참고 |
| 3 | TarRlteTarService1 | `ingest` | 3,570,406행 |
| 4 | LocgoHubTarService1 | `ingest:locgo`·`ingest:locgo-detail` | 555,967 + 54,478행 |
| 5 | KorService2 | `ingest:kor`·`ingest:kordetail` | 61,627 + 39,068행 |
| 6 | DataLabService | `ingest:datalab` | 1,309행(슬림 집계) |
| 7 | KorWithService2 | `ingest:korwith`·`ingest:withdetail` | 10,273행 |
| 8 | TatsCnctrRateService | `ingest:tats` | 832,842행 |
| 9 | KorPetTourService2 | `ingest:pet`·`ingest:pet-detail` | 9,767 + 9,767행 |

> ⚠️ **AreaTarDivService — 데이터는 있다. 수집하지 않기로 결정했다(2026-09-05).**
>
> **이전 기록 정정.** "제공기관 미개방" 으로 적어 두었으나 **틀린 진단이었다.** 공식 매뉴얼
> (v4.0)로 확인한 결과, 지표 코드(`touDivIxCd`·`expDivIxCd`·`intlDivIxCd`)가 매뉴얼에는
> **옵션(0)** 으로 표기돼 있지만 **없으면 `totalCount 0`** 이 온다. 필수 파라미터(`areaCd`,
> `baseYm`)만 보낸 우리 호출이 계속 빈 결과를 받은 이유다. `resultCode 0000` + `totalCount 0`
> 을 "데이터 없음" 으로 읽은 것이 오판이었다 — 에러가 아니라 조건 불충족이었다.
>
> **실제 제공 범위**: 202510~202607(10개월, 매월 16일 갱신) · 전국 17개 시도 · **272개 시군구** ·
> 지표 20종(관광객 8·소비 8·국제 4). 전량은 3,400 호출 / 약 54,400행.
>
> **수집하지 않는 이유** — 지표의 성격이 우리 용도와 맞지 않는다(실측):
> - 이름은 "다양성" 이지만 실제로는 **상권 규모**를 잰다. 상위가 강남·서초·송파·중구, 하위가
>   울릉군·영양군이다. 여행지로서의 성격이나 접근성이 아니다.
> - **연령별 지표가 전체 지표와 사실상 같은 값이다** — 전체↔70대 r=0.962, 전체↔10대 r=0.952.
>   "고령자가 편한 지역" 신호를 기대했으나, 70대 방문객 상위가 강남·송파·서초다. 고령자 친화가
>   아니라 사람 많은 곳에 노인도 많은 것이다.
> - **시간에 따라 거의 변하지 않는다.** 강원 중앙값이 202510→202607 동안 63.3/61.4/61.5/63.6,
>   최고 시군구는 계속 원주시다. 성수기 판단에는 `tats_region_daily`·`tats_cnctr` 가 훨씬 낫다.
> - **시군구 단위**라 장소 단위로 후보를 고르는 추천 엔진에 쓸 자리가 없다.
>
> 국제적 다양성(33)만 전체 지표와 상관이 낮아(r=0.454) 새로운 축이지만, 무장애 여행 추천에
> 쓸 근거가 되지 않는다. 용도가 생기면 지표 코드를 넣어 호출하면 바로 받을 수 있다.

> ⚠️ **식품_관광식당은 다른 API 와 두 가지가 다르다.**
> ① `_type=json` 이 아니라 **`type=json`** 을 받는다(행안부 규약).
> ② 응답이 사업장이 아니라 **갱신 이력**이다 — 526 레코드가 사업장 218곳이다(`MNG_NO` 중복,
> `DAT_UPDT_SE` I/U). 사업장별 최신 레코드만 골라야 하며, 행 수를 업소 수로 세면 두 배 넘게
> 부풀려진다.
> ③ **원본 좌표(`CRD_INFO_X/Y`)를 쓸 수 없다.** 투영좌표계인데 원점이 어느 표준 정의와도
> 맞지 않는다 — 카카오 지오코딩 40건과 대조해 ΔX 중앙 −72m / ΔY 중앙 −309m(표준편차 31/16m)
> 의 일정한 오프셋이 나왔다. 그래서 주소를 카카오로 지오코딩해 WGS84 를 얻는다(영업중 142곳
> 중 **141곳 성공**, 실패 1곳은 카카오에 없는 옛 지번).

## 오퍼레이션

**1. 식품_관광식당** (`/1741000/tourist_restaurants`)
- `/info` 데이터 조회 (매일 갱신, 2일전 기준) · `/history` 이력조회 (2026.01.01~)

**2. 지역별 관광 다양성** (`AreaTarDivService`) — 수집 안 함(위 ⚠️)
- ⚠️ 매뉴얼 v4.0 의 서비스 명세표는 3번 오퍼레이션을 `areaTarDivService` 로 적었으나 **오타**다.
  실제 이름은 `areaIntlDivList` 이며 매뉴얼 뒤쪽 Call Back URL 이 맞다.
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
| AreaTarDivService `/areaTouDivList`·`/areaExpDivList`·`/areaIntlDivList` | `areaCd`, `baseYm`, **+ 지표코드**(`touDivIxCd`/`expDivIxCd`/`intlDivIxCd`) | ⚠️ 지표코드는 매뉴얼상 옵션이지만 **없으면 0건**. `signguCd` 를 빼면 그 시도의 전 시군구가 한 번에 온다(서울 26행) | baseYm, areaCd, areaNm, signguCd, signguNm, {tou\|exp\|intl}DivIxCd/Nm/Val |

- 인증키 공용, 각 서비스 일일 트래픽 독립.
- 법정동 코드체계(areaCd 2자리 시도, signguCd 5자리). 시군구 목록은 [src/sigungu-codes.json](../src/sigungu-codes.json) 재사용.
