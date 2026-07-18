-- 리뷰 사진 URL 배열 — 유저 직접 업로드를 대비한 범용 스키마.
--  현재(쓰기 API 도입 전)는 시연 시드에 관광공사(kor_poi firstimage) 사진을 채워 쓴다.
--  개수를 1~5장으로 다양화해 앱의 사진 수별 레이아웃(1/2/3/4장+오버플로)을 시연한다.
--  ⚠️ 관광공사 사진 표출 시 출처 표시 필요 (image_copyright 준수).
alter table reviews add column if not exists image_urls text[] not null default '{}';

-- 시연용 시드 사진 채우기 (비어 있을 때만 → 재실행·유저 업로드 도입에 안전)
update reviews set image_urls = v.urls
from (values
  -- 준호 · 경복궁 · 1장
  ('준호', array['https://tong.visitkorea.or.kr/cms/resource/98/3487598_image2_1.jpg']),
  -- 도현 · 강릉 안목해변 · 2장
  ('도현', array['https://tong.visitkorea.or.kr/cms/resource/58/4075958_image2_1.jpg',
                 'https://tong.visitkorea.or.kr/cms/resource/58/4075958_image3_1.jpg']),
  -- 지우 · 순천만 국가정원 · 3장
  ('지우', array['https://tong.visitkorea.or.kr/cms/resource/36/4066436_image2_1.jpg',
                 'https://tong.visitkorea.or.kr/cms/resource/22/2588422_image2_1.jpg',
                 'https://tong.visitkorea.or.kr/cms/resource/22/2588422_image3_1.jpg']),
  -- 민지 · 서울 와룡공원 · 4장
  ('민지', array['https://tong.visitkorea.or.kr/cms/resource/93/1395493_image2_1.jpg',
                 'https://tong.visitkorea.or.kr/cms/resource/93/1395493_image3_1.jpg',
                 'https://tong.visitkorea.or.kr/cms/resource/18/3573618_image2_1.jpg',
                 'https://tong.visitkorea.or.kr/cms/resource/18/3573618_image3_1.jpg']),
  -- 하은 · 부산 구포시장 · 5장 (+1 오버레이 시연)
  ('하은', array['https://tong.visitkorea.or.kr/cms/resource/38/3081238_image2_1.JPG',
                 'https://tong.visitkorea.or.kr/cms/resource/38/3081238_image3_1.JPG',
                 'https://tong.visitkorea.or.kr/cms/resource/17/3397217_image2_1.jpg',
                 'https://tong.visitkorea.or.kr/cms/resource/17/3397217_image3_1.jpg',
                 'https://tong.visitkorea.or.kr/cms/resource/80/2755680_image2_1.jpg']),
  -- 서연 · 제주 9.81 파크 · 2장
  ('서연', array['https://tong.visitkorea.or.kr/cms/resource/85/3408185_image2_1.png',
                 'https://tong.visitkorea.or.kr/cms/resource/85/3408185_image3_1.png']),
  -- 유나 · 전주 한옥마을 · 3장
  ('유나', array['https://tong.visitkorea.or.kr/cms/resource/02/2568902_image2_1.jpg',
                 'https://tong.visitkorea.or.kr/cms/resource/39/2568339_image2_1.jpg',
                 'https://tong.visitkorea.or.kr/cms/resource/43/2594443_image2_1.png'])
) as v(author, urls)
where reviews.author_nm = v.author and reviews.image_urls = '{}';
