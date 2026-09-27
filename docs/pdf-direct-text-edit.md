# PDF 텍스트 이동: 직접 제거와 overlay 저장

PDF 뷰어에서 **텍스트 이동**을 켜고 텍스트를 선택해 이동한 뒤 **다운로드 → PDF**로 저장한다.
화면 미리보기는 기존 overlay를 유지한다. 다운로드 시 원본 콘텐츠를 분석해 직접 제거 가능한
선택은 원래 출력 명령을 삭제하고 새 위치에 텍스트를 추가한다. 직접 제거된 자리에 배경색
사각형을 그리지 않으므로 원래 배경과 표 선을 유지할 수 있다.

저장 후 패널에는 `원본 텍스트 제거 N건 · 배경색 덮기 M건`을 표시한다. 결과 객체의
`textMoveResults`에는 각 객체의 `direct`/`overlay` 처리 방식과 fallback 사유가 들어간다.

## 원본 글꼴 재사용 범위

- PDF.js의 텍스트 덩어리 한 개 **전체**를 선택한 경우.
- Type1/TrueType의 표준 인코딩 또는 ToUnicode 매핑, 그리고 Identity-H + ToUnicode가 있는
  Type0/CID 글꼴. 기존 문자 코드와 원본 글꼴 resource를 그대로 이동 위치에 다시 출력한다.
- 회전/크롭/UserUnit 변경이 없는 페이지의 가로 텍스트.
- `BT … ET` 안에 출력 명령이 하나인 `Tj`, 또는 숫자 간격 조정이 0인 `TJ`.
- 원본 문자열과 6개 변환 좌표가 유일하게 일치하고 다른 이동/교체 원본 영역과 겹치지 않는 경우.
- 단순 그래픽 경로·색상·선 스타일과 압축/다중 Contents 스트림을 포함하는 페이지.

부분/여러 덩어리 선택, ToUnicode가 없는 임베디드 글꼴, 복잡한 CMap, Identity-V, 여러 출력
명령이 연결된 텍스트 객체, 비영(非零) 커닝, 회전/세로쓰기, Form XObject, 인라인 이미지,
특수 그래픽 상태, 클리핑/태그 등 지원하지 않는 명령이 있는 페이지는 기존 overlay로 저장한다.
복잡한 명령이나 지원하지 않는 텍스트가 하나라도 있으면 해당 페이지의 직접 제거를 시도하지 않는다.
스캔 이미지 속 글자는 이 기능의 대상이 아니다.

## 구현 경계

- `PdfTextLayer.jsx`는 PDF.js 텍스트 항목의 원본 문자열/변환 좌표만 span에 기록한다.
- `PdfPage.jsx`는 선택이 전체 항목인지 확인하여 `sourceSelection`을 이동 객체에 저장한다.
- `pdfFontAnalysis.js`는 font resource, subtype, 임베딩/subset 상태, 인코딩, ToUnicode 매핑을
  분석한다. `pdfFontPreview.js`는 PDF.js의 glyph 문자와 화면 Unicode 문자를 분리해 기록한다.
- `pdfDirectTextEdit.js`는 문자열·배열·주석을 구분해 파싱하고 원본을 검증한 뒤 출력 명령을
  제거한다. 직접 재사용이면 같은 font resource와 원본 encoded glyph를 새 text matrix에 다시
  출력한다. 인접 텍스트의 위치에 영향을 줄 수 있는 여러 출력 명령은 지원하지 않는다.
- 공유 Contents를 직접 변경하지 않고 페이지에 새 스트림을 연결한다. 교체된 이전 스트림 중
  PDF 객체 그래프에서 더 이상 참조되지 않는 것만 제거한다. 다른 페이지가 공유하는 원본은 보존한다.
- `pdfOverlayConvertService.js`는 직접 제거 성공 영역의 덮개를 생략한다. 모든 fallback 덮개를
  먼저 그리고 모든 새 텍스트를 나중에 그려, 후속 덮개가 이동한 텍스트를 지우지 않게 한다.
- 직접 재사용 결과에는 `directMovedCount`, `originalFontReuseCount`, `fallbackOverlayCount`,
  `failedCount`, `fallbackReasons`와 개별 font metadata를 반환한다. fallback 새 텍스트는
  NotoSansKR Regular(400) 인스턴스에서 필요한 글자만 임베딩한다.
- 원본 업로드 파일은 변경하지 않는다. DOCX와 즉시 텍스트 교체 자체의 원본 삭제는 이번 범위에 없다.

이는 문서 이동 편집 기능이며 파일 전체의 개인정보 완전 삭제(redaction)를 보장하는 기능은 아니다.
다른 페이지, 메타데이터, 첨부 파일 등에 있는 같은 텍스트는 제거 대상이 아니다.

## 검증

`frontend` 디렉터리에서 실행:

```sh
npm run test:pdf-edit
npx playwright test tests/pdf-direct-text-move.spec.js --workers=1 --output=/tmp/docpilot-pdf-edit-results
npm run build
```

Node 테스트는 생성한 PDF를 저장·재로딩하고 PDF.js 텍스트 추출 및 캔버스 렌더링으로 검증한다.
동일 문구 구분, 공유 스트림 보존, 불필요한 원본 스트림 정리, 부분/모호한 선택 fallback,
배경색 보존, 이동+치환 동시 저장과 겹친 대상의 그리기 순서를 검사한다.
브라우저 테스트는 선택·드래그·확대/축소·실제 다운로드·전체 초기화를 검사한다.
유형별 수동 확인 절차는 [PDF 원본 글꼴 재사용 저장 검증 체크리스트](./pdf-font-reuse-save-test-checklist.md)를 따른다.
