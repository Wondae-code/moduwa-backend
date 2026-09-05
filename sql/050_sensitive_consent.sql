-- 민감정보(접근성 특성) 별도 동의 기록.
--
--  authors.access_features 는 장애 관련 정보이고, 개인정보보호법상 **민감정보**다. 그런데
--  지금까지 "동의를 받았다" 는 사실을 어디에도 남기지 않았다 — 앱이 체크박스를 보여 줬는지조차
--  서버는 알 수 없다. 법은 동의를 받은 사실을 **처리자가 입증**하도록 하므로, 기록이 없으면
--  "동의 없이 수집했다" 는 주장에 반증할 수단이 없다.
--
--  /privacy 2항에 이미 "다른 항목과 분리된 별도 동의를 받는다" 고 적어 두었다. 구현이 그 말과
--  달랐던 것을 여기서 맞춘다 — 방침과 구현이 어긋나는 것 자체가 심사 지적 사유다.
--
-- ⚠️ **버전을 함께 남긴다.** 고지 문구가 바뀌면 "무엇에 동의했는가" 가 달라진다. 시각만 남기면
--    나중에 문구를 고쳤을 때 예전 동의가 무엇을 담고 있었는지 되짚을 수 없다.
--
-- ⚠️ **기존 행의 access_features 를 지우지 않는다.** 동의를 안 받았다는 뜻이 아니라 **기록하지
--    않았다**는 뜻이다(앱이 물어봤을 수 있다). 지우면 이용자가 등록한 정보가 말없이 사라진다.
--    대신 consent_at 이 null 로 남고, 앱이 그 사람에게 다시 묻는다(서버가 needsSensitiveConsent
--    로 알려 준다). 다시 묻고 거부하면 그때 지운다.
--
--  migrate 는 내용 해시로 재적용을 판단하므로 이 파일은 멱등이어야 한다.

alter table authors add column if not exists sensitive_consent_at  timestamptz;
alter table authors add column if not exists sensitive_consent_ver text;

comment on column authors.sensitive_consent_at is
  '접근성 특성(민감정보) 수집·이용에 동의한 시각. null 이면 동의 기록이 없다 — 앱이 다시 묻는다.';
comment on column authors.sensitive_consent_ver is
  '동의받은 고지문 버전(예: 2026-09-05). 문구가 바뀌면 무엇에 동의했는지 달라지므로 함께 남긴다.';

-- 운영이 "동의 기록 없이 민감정보를 들고 있는 계정" 을 찾는 경로. 다시 물어야 할 대상이다.
create index if not exists idx_authors_sensitive_pending on authors (id)
  where access_features <> '{}' and sensitive_consent_at is null;
