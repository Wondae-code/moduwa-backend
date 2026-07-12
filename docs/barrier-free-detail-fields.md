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

## 비고
- 호출: `GET .../KorWithService2/detailWithTour2?serviceKey=…&MobileOS=ETC&MobileApp=…&_type=json&contentId={id}`
- 콘텐츠당 1요청 → 9,956건 enrich 시 일 1,000 제한으로 약 11일(또는 지역/유형 샘플).
- 장소마다 채워진 필드 수가 다름(샘플: 음식점 5개, 숙박 6개, 문화시설 3개 등) — 모든 장소가 28개를 다 갖진 않음.
- 필드명→의미는 필드명·샘플값 기반 정리. 정확한 공식 정의는 활용가이드(국문) 문서 참고.
