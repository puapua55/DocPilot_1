# PDF 이동 텍스트 저장 문제 수정 기록

## 문제

PDF 뷰어에서는 이동한 `DocPilot`이 정상적으로 보였지만, PDF로 다운로드한 뒤에는 다음과 같이 표시되는 문제가 있었다.

- 원본: `DocPilot`
- 저장 PDF: `oc ilot`
- 저장 PDF에서 글꼴과 색상도 원본과 다르게 표시됨

## 원인

이동 텍스트 저장 시 원본 PDF의 subset font glyph를 content stream에서 직접 재삽입하는 경로가 사용되었다. PDF.js에서는 정상적으로 렌더링되더라도, 저장 PDF에서 해당 raw glyph stream을 다시 재생하면 일부 glyph가 누락될 수 있다.

또한 직접 재사용이 실패해 Unicode overlay로 전환되는 경우, 화면 text layer의 기본 색상이 실제 PDF 글자 색상과 달라 fallback 텍스트가 검정색으로 저장될 수 있었다.

## 수정 내용

### 1. subset font glyph 재사용 제한

`pdfDirectTextEdit.js`에서 subset font는 원본 glyph 직접 재삽입 대상으로 사용하지 않는다.

대신 다음 fallback 경로를 사용한다.

```text
displayText 전체 문자열
        ↓
NotoSansKR Unicode overlay
```

안전한 일반 글꼴은 기존 원본 글꼴 재사용 경로를 유지한다.

### 2. fallback 텍스트 색상 보정

`PdfPage.jsx`에서 선택된 원본 canvas 영역의 픽셀을 분석해 실제 텍스트 색상을 추출한다.

fallback overlay 저장 시 다음 우선순위를 사용한다.

```text
canvas에서 추출한 원본 텍스트 색상
        ↓ 실패 시
기존 computedStyle 색상
        ↓ 실패 시
기본 텍스트 색상
```

따라서 원본이 파란색인 경우 fallback 텍스트도 파란색으로 저장된다.

### 3. 저장 결과 진단 정보 추가

저장 결과의 `textMoveResults`에 다음 정보를 포함한다.

- `displayText`
- `originalGlyphText`
- `drawnText`
- `drawnTextLength`
- `measuredWidth`
- `movedRectWidth`
- `usedMaxWidth`
- `fontPreserved`
- `canReuseOriginalFont`

문서 전체 텍스트를 로그로 출력하지 않고, 이동 객체별 상태만 확인할 수 있다.

### 4. cover 및 저장 순서 확인

- 원본 위치 cover는 fallback 대상에만 적용
- 직접 글꼴 재사용 대상에는 cover를 중복 적용하지 않음
- 모든 cover를 먼저 그림
- fallback 텍스트를 cover 이후에 그림
- `drawText`에 이동 영역 기준 `maxWidth`를 사용하지 않음

## 변경 파일

- `frontend/src/services/pdfDirectTextEdit.js`
  - subset font 직접 glyph 재사용 제한
- `frontend/src/components/PdfPage.jsx`
  - 원본 canvas 기반 텍스트 색상 추출
- `frontend/src/services/pdfOverlayConvertService.js`
  - 저장 폭 측정 및 결과 진단 정보 추가

화면 표시용 `displayText`와 PDF 저장용 glyph/font 정보 분리 구조는 유지했다. DOCX 관련 코드는 수정하지 않았다.

## 검증 결과

실행한 테스트:

```bash
cd frontend
npm run test:pdf-edit
npm run build
```

결과:

- PDF 저장 테스트 20건 통과
- 프론트엔드 production build 통과
- `git diff --check` 통과

## 재확인 절차

1. PDF 업로드
2. 텍스트 이동 모드 활성화
3. `DocPilot` 선택
4. 다른 위치로 이동
5. PDF 다운로드
6. 다운로드한 PDF를 외부 PDF 뷰어에서 열기
7. `DocPilot` 전체가 표시되는지 확인
8. `D`, `P`가 누락되지 않는지 확인
9. 원본 색상과 크게 다르지 않은지 확인
10. 한글 및 영문 혼합 텍스트도 확인

## 참고

subset font는 PDF.js 화면에서는 정상이어도 저장 후 raw glyph 재사용이 항상 안전하지 않다. 따라서 저장 결과의 텍스트 정확성을 우선해 Unicode fallback을 사용하도록 처리했다.

## 재확인 후 추가 수정

실제 다운로드 결과에서 문제가 계속되는 사례를 반영해 저장 분기를 한 단계 더 보수적으로 변경했다.

- PDF 다운로드 경로가 `PdfJsViewer → App.jsx → convertPdfWithOriginalOverlay → buildPdfWithTextEdits`임을 재확인
- movable object에 `sourceFont.glyphText` 또는 `originalGlyphText`가 있으면 raw glyph direct reuse를 차단
- 해당 객체는 반드시 `displayText` 전체를 NotoSansKR Unicode overlay로 저장
- 저장 결과 debug에 `fallbackUsed`를 추가
- `displayText`, `drawnText`, `drawnTextLength`가 일치하는 회귀 테스트 추가

추가 검증 결과:

- PDF 저장 테스트 21건 통과
- glyph preview가 있는 `DocPilot` 이동 객체도 `drawnText: "DocPilot"`로 저장되는 테스트 통과

## 한글 누락 사례 후 추가 보강

`색·편집·저장 기능을 하나의 프로그램에서 제공하기 위해 추진됩니다.`처럼 일부 한글이 빈칸으로 보이는 사례를 재검증했다.

- UI에서 생성한 movable object에 `forceUnicodeFallback: true`를 저장
- 다운로드 시 해당 객체는 원본 raw glyph direct reuse를 수행하지 않음
- 항상 `displayText` 전체를 NotoSansKR fallback subset으로 저장
- variable font의 전체 임베딩은 일부 PDF 뷰어에서 Unicode CMap을 손상시키므로 사용하지 않음
- 실제 한글 문장을 저장한 뒤 PDF.js `textContent`에서 전체 문자열이 추출되는 회귀 테스트 추가

이 정책은 이동 텍스트의 저장 정확성을 원본 글꼴 재사용보다 우선한다. 기존 direct font reuse 구현은 UI glyph preview가 없는 안전한 호출 경로에 계속 남아 있다.

## glyph는 복사되지만 보이지 않는 사례 수정

저장 PDF에서 선택/복사는 정상인데 일부 한글 glyph만 빈칸으로 렌더링되는 사례를 확인했다. 이는 ToUnicode 문자열이 아니라 variable font subset의 outline 렌더링 호환성 문제다.

- fallback PDF text는 계속 유지해 검색·선택·복사를 지원
- 같은 fallback 글꼴의 glyph path를 벡터 outline으로 추가 저장
- 외부 PDF 뷰어가 subset font glyph를 빈칸으로 렌더링해도 벡터 outline이 글자를 표시
- `색·편집·저장 기능을 하나의 프로그램에서 제공하기 위해 추진됩니다.` 문장을 저장하고 PDF.js canvas로 렌더링해 전체 glyph 표시를 확인

## 원본 위치 처리 변경

이동 전 위치의 글자를 흰 사각형으로 가리는 방식을 우선 사용하지 않도록 변경했다.

- UI 선택 이동 객체는 원본 content stream에서 정확히 일치하는 텍스트 명령을 먼저 제거
- 새 위치에는 Unicode text와 glyph vector outline을 저장
- 원본 텍스트를 유일하게 확인할 수 없거나 복잡한 PDF content stream인 경우에만 안전한 cover fallback 사용
- 저장 결과의 `method`는 `direct-remove-overlay`로 원본 삭제와 Unicode overlay 삽입이 함께 적용됐음을 표시
