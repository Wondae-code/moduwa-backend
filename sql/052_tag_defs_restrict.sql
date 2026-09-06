-- 태그 정의를 지우면 사용자가 붙인 태그가 함께 사라지는 것을 막는다.
--
--  019 가 review_tags.tag_code 에 **on delete cascade** 를 걸어 뒀다. 그 자체는 흔한 선택이지만
--  이 표에서는 결과가 다르다 — review_tag_defs 는 사용자 데이터가 아니라 **우리가 관리하는
--  카탈로그**이고, review_tags 는 **이용자가 자기 후기에 직접 밝힌 내용**이다. 카탈로그에서 한 줄을
--  지우면 그 항목을 고른 사람들의 기록이 전부 조용히 지워진다.
--
-- ⚠️ **실측(2026-09-07, 로컬, 롤백함).** 후기 7건에 visit_visual 을 붙인 뒤
--       delete from review_tag_defs where code = 'visit_visual';
--    한 줄로 review_tags 21행 → 14행. **에러도 경고도 없다.** 되돌릴 방법도 없다.
--
--  이 경로가 열리는 실제 상황은 "축 이름 바꾸기" 다. 코드를 바꾸는 방법이 둘인데 결과가 정반대다:
--    · update review_tag_defs set code = ... → **FK 가 막는다**(on update no action). 안전하다.
--    · delete 후 새로 insert            → **통과되고 사용자 태그가 날아간다.**
--  둘 중 위험한 쪽이 더 자연스러워 보인다는 게 문제다. restrict 로 바꾸면 둘 다 막힌다.
--
--  restrict 로 바꿔도 지금 깨지는 것은 없다 — 코드에 review_tag_defs 를 지우는 경로가 없고,
--  019·051 은 insert ... on conflict do update 만 한다. 정말로 카탈로그에서 항목을 빼야 할 때는
--  review_tags 를 어떻게 할지 **먼저 정하고** 그 다음에 지우게 된다. 그 순서가 맞다.
--
--  migrate 는 내용 해시로 재적용을 판단하므로 이 파일은 멱등이어야 한다.

do $$
begin
  if exists (
    select 1 from information_schema.referential_constraints
     where constraint_schema = 'public'
       and constraint_name = 'review_tags_tag_code_fkey'
       and delete_rule = 'CASCADE'
  ) then
    alter table review_tags drop constraint review_tags_tag_code_fkey;
    alter table review_tags add constraint review_tags_tag_code_fkey
      foreign key (tag_code) references review_tag_defs(code) on delete restrict;
  end if;
end $$;

-- ── 축 이름을 바꾸려는 사람에게 (같은 축이 세 곳에 다른 이름으로 있다) ────────────────
--
--  위 restrict 는 **한 어휘만** 덮는다. 같은 다섯 축이 세 벌로 저장돼 있고 저장 방식이 다르다:
--
--    축     authors/posts.access_features   /v1/barrier-free?access=   review_tag_defs
--           (030 · 027, 그냥 text[])        (코드 안의 고정 맵)        (이 표, FK 있음)
--    지체   wheelchairAccessible            wheelchair                 visit_wheelchair
--    시각   visuallyImpairedFriendly        visual                     visit_visual
--    청각   hearingFriendly                 hearing                    visit_hearing
--    유아   childFriendly                   infant                     visit_infant
--    고령   elderlyFriendly                 elderly                    visit_elderly
--
--  ⚠️ **한 번의 이름 변경이 세 곳에 정반대로 도착한다.**
--       · review_tag_defs      → FK 가 막는다. 에러가 난다. 알게 된다.
--       · access= 맵           → 앱이 보내는 이름과 어긋나면 필터가 그냥 안 걸린다.
--       · access_features      → 검증할 표가 없다. 옛 문자열이 그대로 남아 아무것과도 안 맞는다.
--    소실이 아니라 불일치라 052 가 막은 것보다 가볍지만, **이 열이 050 에서 민감정보로 분류한
--    바로 그 열이다.** 무거운 쪽에 자물쇠가 없다.
--
--  ⚠️ **access_features 에 CHECK 를 걸지 않았다.** 걸면 앱이 축을 늘릴 때마다 서버 배포가
--     먼저여야 하고, 그 순서가 어긋나면 가입·프로필 저장이 400 이 된다 — 050 때 실제로 낸 사고다.
--     자유 문자열로 두는 것이 그때 배운 것의 결과이고, 대신 이 표를 여기 남긴다.
--
--  유아 축이 childFriendly ↔ infant ↔ visit_infant 다. 어간이 서로 다르므로 **문자열 규칙으로
--  세 벌 사이를 오갈 수 없다.** 접두어를 떼거나 붙여 맞히려 들지 말 것.
