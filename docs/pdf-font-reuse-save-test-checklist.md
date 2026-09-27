# PDF 원본 글꼴 재사용 저장 검증 체크리스트

## 목적

텍스트 이동 저장 시 선택한 원본 텍스트만 제거하고, 이동한 위치에는 같은 PDF 글꼴 리소스와
원본 문자 코드를 재사용하는지 확인한다. 직접 재사용 기준을 충족하지 못한 문서는 원본을
변경하지 않고 overlay로 저장되어야 한다.

## 자동 검증 범위

`frontend`에서 다음을 실행한다.

```sh
npm run test:pdf-edit
npx playwright test tests/pdf-direct-text-move.spec.js tests/pdf-overlay-regression.spec.js --workers=1
npm run build
```

자동 테스트는 다음을 생성·저장·PDF.js 재열기로 검증한다.

- 기본 Type1 영문 PDF
- Times Bold Italic PDF
- ToUnicode가 있는 임베디드 Type0 한글 PDF
- ToUnicode가 없는 Type0 글꼴의 overlay fallback
- 동일 문자열 반복 PDF
- 표 선과 색 배경이 있는 PDF

## 수동 테스트 PDF 유형

각 문서에서 **텍스트 이동**을 켜고 PDF.js text item 한 개 전체를 선택하여 이동한 뒤
다운로드한 PDF를 새로 연다.

| 유형 | 직접 원본 글꼴 재사용 기대 | 확인할 항목 |
| --- | --- | --- |
| 기본 영문 Type1/TrueType | ToUnicode 또는 표준 인코딩이 확인되면 허용 | 폰트명, 크기, 색, 검색/복사 |
| Bold/Italic | 원본 글꼴 리소스를 확인하면 허용 | 굵기·기울임, 좌표 |
| 임베디드 한글 Type0/CID | Identity-H와 ToUnicode가 모두 안전하면 허용 | 한글 깨짐, 검색/복사, 원본 resource |
| Type0/CID 매핑 불확실 | overlay | fallback 사유, PDF 정상 열기 |
| 동일 문자열 반복 | 선택 좌표가 유일하면 허용 | 선택하지 않은 동일 문자열 보존 |
| 표/배경 | 직접 재사용이면 허용 | 표 선, 배경색, 원본 위치 잔상 |

## 저장 후 확인 항목

- 원본 위치에서 선택한 글자가 한 번만 제거되었는가.
- 이동 위치에 텍스트가 한 번만 표시되는가.
- `원본 글꼴 유지`, `overlay 처리`, `실패` 건수가 저장 결과와 일치하는가.
- 직접 재사용이면 저장 전후 PDF의 글꼴 resource name, BaseFont, subtype이 유지되는가.
- 굵기, 기울임, 글자 크기, 색상이 원본과 동일한가.
- PDF.js 텍스트 검색과 복사가 이동 위치의 텍스트에서 동작하는가.
- 확대 비율 80%, 100%, 150%, 200%에서 저장 좌표가 달라지지 않는가.
- 표 선, 배경색, 인접 텍스트가 원본 위치의 처리로 손상되지 않는가.

## fallback 기록 양식

```text
PDF 유형:
페이지 / 선택 텍스트 길이:
원본 글꼴: resource / BaseFont / subtype / embedded / subset
처리 방식: direct | overlay
fallbackReason:
저장 PDF 재열기: 성공 | 실패
검색/복사: 성공 | 실패
좌표/모양 이슈:
```

## 직접 재사용 금지 조건

- ToUnicode 또는 표준 인코딩으로 원본 문자 코드를 확인할 수 없음
- 복잡한 CMap, Identity-V, 가변 길이 문자 코드, 회전/세로쓰기
- 선택 범위가 text item 전체가 아님
- 여러 출력 명령, 비영 kerning, 여러 글꼴이 섞임
- 동일 문자열과 좌표의 매칭이 유일하지 않음
- Form XObject, 인라인 이미지, 지원하지 않는 콘텐츠 명령

이 경우에는 원본 stream을 변경하지 않고 overlay fallback으로 저장한다.
