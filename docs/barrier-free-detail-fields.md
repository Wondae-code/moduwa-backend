# 무장애 여행 상세 속성 (KorWithService2 / detailWithTour2)

`contentId`로 호출하면 해당 장소의 무장애(배리어프리) 편의시설을 **자유 텍스트 설명**으로 반환.
각 필드는 채워져 있으면 시설 설명, 비어 있으면 정보 미제공. (총 28개 속성 + contentid)

예) `restroom` = "장애인 전용 화장실 있음(주차장 안 아름다운가계 화장실, 경사로설치)"
    `braileblock` = "점자블록 있음(아름다운가계 화장실 앞)_시각장애인 편의시설"

## ① 지체장애 · 공통 이동 편의 (12)
| 필드 | 의미 |
|---|---|
| `parking` | 장애인 전용 주차구역 |
| `route` | 장애인 편의 이동경로(접근로·경사로) |
| `publictransport` | 대중교통 접근성 |
| `exit` | 주 출입구 접근 |
| `elevator` | 엘리베이터 |
| `restroom` | 장애인용 화장실 |
| `wheelchair` | 휠체어 대여 |
| `ticketoffice` | 매표소·안내데스크 접근 |
| `auditorium` | 관람석·좌석 |
| `room` | (숙박) 장애인 객실 |
| `promotion` | 안내·홍보물 |
| `handicapetc` | 기타 지체장애 편의 |

## ② 시각장애 편의 (8)
| 필드 | 의미 |
|---|---|
| `braileblock` | 점자블록 |
| `audioguide` | 음성(오디오) 안내 |
| `guidehuman` | 인적 안내(도우미) |
| `helpdog` | 안내견 동반 가능 |
| `bigprint` | 큰 활자 안내물 |
| `brailepromotion` | 점자 안내물 |
| `guidesystem` | 유도·안내 설비 |
| `blindhandicapetc` | 기타 시각장애 편의 |

## ③ 청각장애 편의 (4)
| 필드 | 의미 |
|---|---|
| `signguide` | 수어 안내 |
| `videoguide` | 영상 자막·수어영상 |
| `hearingroom` | 청각 안내실·보청 설비 |
| `hearinghandicapetc` | 기타 청각장애 편의 |

## ④ 영유아·가족 편의 (4)
| 필드 | 의미 |
|---|---|
| `stroller` | 유모차 대여 |
| `lactationroom` | 수유실 |
| `babysparechair` | 유아용 의자 |
| `infantsfamilyetc` | 기타 영유아·가족 편의 |

## ⑤ 고령자 (파생 — 위 속성에서 계산)

관광공사 열린관광(access.visitkorea.or.kr)의 공식 분류는 **5개 유형**이고 다섯째가 고령자다.
①~④와 달리 **전용 속성이 따로 있지 않다** — 공식 항목이 "휠체어 대여 · 이동보조기기 대여"
둘뿐이고, 그 값은 이미 ①의 `wheelchair`와 `handicapetc`에 들어 있다.

| 판정에 쓰는 것 | 출처 필드 | 비고 |
|---|---|---|
| 휠체어 대여 | `wheelchair` (①) | 공식 항목. 값 예: `대여가능(2대)` |
| 이동보조기기 대여 | `handicapetc` (①) 본문 정규식 | 공식 항목이지만 **실측 3건**뿐 |
| 승강기 | `elevator` (①) | 계단 회피 |
| 주차 | `parking` (①) | 걷는 거리 단축 |

**넷 중 하나라도 있으면** `access_elderly`가 켜진다 → 6,231곳(60.7%).
공식 2항목만 쓰면 1,486곳(14.5%)에 그치는데, 대부분의 고령 여행자는 휠체어를 쓰지 않고
실제로 겪는 문제는 계단과 걷는 거리다. 정의는 `sql/037_access_elderly.sql` 참고.

> ⚠️ ①과 속성이 겹친다. 배타적 분류가 아니라 **관점별 묶음**이라 의도된 것이다.

## 비고
- 호출: `GET .../KorWithService2/detailWithTour2?serviceKey=…&MobileOS=ETC&MobileApp=…&_type=json&contentId={id}`
- 콘텐츠당 1요청 → 9,956건 enrich 시 일 1,000 제한으로 약 11일(또는 지역/유형 샘플).
- 장소마다 채워진 필드 수가 다름(샘플: 음식점 5개, 숙박 6개, 문화시설 3개 등) — 모든 장소가 28개를 다 갖진 않음.
- 필드명→의미는 필드명·샘플값 기반 정리. 정확한 공식 정의는 활용가이드(국문) 문서 참고.
- **유형 묶음은 28속성을 나눈 것이지 API가 주는 구분이 아니다.** ①~④는 우리가 필드명으로
  묶었고, ⑤ 고령자는 열린관광의 공식 5유형을 따라 ①에서 파생시킨 것이다.
  API 응답의 `access.{wheelchair,visual,hearing,infant,elderly}`가 이 묶음이다.
