import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inferDocumentCommand } from '../electron/documentCommandParser.js';

test('따옴표가 없는 검색 문장에서 검색어를 추출한다', () => {
  assert.deepEqual(inferDocumentCommand('테그스 찾아줘')?.action, {
    type: 'search',
    keyword: '테그스'
  });
  assert.equal(inferDocumentCommand('문서에서 프로젝트를 검색해줘')?.action?.keyword, '프로젝트');
  assert.deepEqual(inferDocumentCommand('문서 를 2개만 찾아줘')?.action, {
    type: 'search',
    keyword: '문서',
    limit: 2,
    order: null
  });
  assert.deepEqual(inferDocumentCommand('문서를 끝페이지 기준으로 2개만 찾아줘')?.action, {
    type: 'search',
    keyword: '문서',
    limit: 2,
    order: 'last'
  });
  assert.deepEqual(inferDocumentCommand('문서 를 첫페이지 기준으로 2개만 찾아줘')?.action, {
    type: 'search',
    keyword: '문서',
    limit: 2,
    order: 'first'
  });
  assert.equal(inferDocumentCommand("'문서 를' 2개만 찾아줘")?.action?.keyword, '문서 를');
});

test('따옴표 사용 여부와 관계없이 일괄 변경의 원문과 새 문구를 추출한다', () => {
  assert.deepEqual(inferDocumentCommand('PDF를 TXT로 바꿔줘')?.action, {
    type: 'batch-replace',
    originalText: 'PDF',
    newText: 'TXT',
    all: false,
    targets: []
  });
  assert.equal(
    inferDocumentCommand("'문서 검색 및 편집 지원 프로그램'을 'DocPilot'로 변경해줘")?.action?.originalText,
    '문서 검색 및 편집 지원 프로그램'
  );
  assert.equal(inferDocumentCommand('PDF -> TXT 교체해줘')?.action?.newText, 'TXT');
});

test('페이지와 색상이 있는 따옴표 없는 하이라이트 요청을 추출한다', () => {
  assert.deepEqual(inferDocumentCommand('2페이지 프로젝트를 노란색으로 하이라이트해줘')?.action, {
    type: 'highlight',
    keyword: '프로젝트',
    all: false,
    color: 'yellow',
    targets: [{ page: 2, occurrence: 1, color: 'yellow' }],
    pageScope: { kind: 'page', page: 2 }
  });
  assert.deepEqual(inferDocumentCommand('문서를 하이라이트 표시')?.action, {
    type: 'highlight',
    keyword: '문서',
    all: true,
    color: 'yellow',
    targets: []
  });
  assert.deepEqual(inferDocumentCommand('프로젝트를 파란색으로 강조해줘')?.action, {
    type: 'highlight',
    keyword: '프로젝트',
    all: true,
    color: 'blue',
    targets: []
  });
});

test('일반 대화나 불완전한 변경 문장은 임의 작업으로 해석하지 않는다', () => {
  assert.equal(inferDocumentCommand('안녕하세요'), null);
  assert.equal(inferDocumentCommand('PDF를 바꿔줘'), null);
});

test('문서 실행 취소, 다시 실행, 전체 초기화 명령을 해석한다', () => {
  assert.deepEqual(inferDocumentCommand('문서상태 이전으로 변경해줘')?.action, { type: 'undo' });
  assert.deepEqual(inferDocumentCommand('다시 실행해줘')?.action, { type: 'redo' });
  assert.deepEqual(inferDocumentCommand('전체초기화 해줘')?.action, { type: 'reset' });
  assert.deepEqual(inferDocumentCommand('마지막 두 작업을 되돌려줘')?.action, { type: 'undo', count: 2 });
  assert.deepEqual(inferDocumentCommand('다시 실행을 세 번 적용해줘')?.action, { type: 'redo', count: 3 });
});

test('첨부된 작업 이력 예문 100개를 undo, redo, reset으로 구분한다', () => {
  const corpus = readFileSync(new URL('./fixtures/offline-chat-requests.txt', import.meta.url), 'utf8');
  const historySection = corpus.split('# 6. 실행 취소·다시 실행·전체 초기화 (100개)')[1].split('# 7.')[0];
  const examples = [...historySection.matchAll(/^(\d{3})\. (.+)$/gm)];
  assert.equal(examples.length, 100);
  for (const [, number, request] of examples) {
    const index = Number(number);
    const expected = index <= 35 ? 'undo' : index <= 70 ? 'redo' : 'reset';
    assert.equal(inferDocumentCommand(request)?.action?.type, expected, `${number}. ${request}`);
  }
});

test('첨부된 검색 예문 100개를 검색 명령으로 구분하고 범위를 추출한다', () => {
  const corpus = readFileSync(new URL('./fixtures/offline-chat-requests.txt', import.meta.url), 'utf8');
  const section = corpus.split('# 1. 문서 내 문구 검색 (100개)')[1].split('# 2.')[0];
  const examples = [...section.matchAll(/^(\d{3})\. (.+)$/gm)];
  assert.equal(examples.length, 100);
  for (const [, number, request] of examples) {
    assert.equal(inferDocumentCommand(request)?.action?.type, 'search', `${number}. ${request}`);
  }
  assert.deepEqual(inferDocumentCommand('5페이지에서 두 번째로 나오는 테스트를 찾아줘')?.action, {
    type: 'search', keyword: '테스트', pageScope: { kind: 'page', page: 5 }, occurrence: 2
  });
  assert.deepEqual(inferDocumentCommand('10페이지 이후에 나오는 검토를 찾아줘')?.action?.pageScope, {
    kind: 'from', startPage: 10
  });
});

test('첨부된 하이라이트 예문을 인식하고 지원하지 않는 색상은 실행하지 않는다', () => {
  const corpus = readFileSync(new URL('./fixtures/offline-chat-requests.txt', import.meta.url), 'utf8');
  const section = corpus.split('# 2. 페이지를 지정한 하이라이트 (100개)')[1].split('# 3.')[0];
  const examples = [...section.matchAll(/^(\d{3})\. (.+)$/gm)];
  assert.equal(examples.length, 100);
  for (const [, number, request] of examples) {
    const result = inferDocumentCommand(request);
    if (/(?:빨간색|연두색|주황색|보라색)/u.test(request)) {
      assert.equal(result?.action, null, `${number}. ${request}`);
    } else {
      assert.equal(result?.action?.type, 'highlight', `${number}. ${request}`);
    }
  }
  assert.equal(inferDocumentCommand('7페이지에서 두 번째로 나오는 변경을 강조해줘')?.action?.targets[0]?.occurrence, 2);
  assert.equal(inferDocumentCommand('첫 페이지의 제목을 하이라이트해줘')?.action?.all, false);
  assert.deepEqual(inferDocumentCommand('1페이지부터 3페이지까지 프로젝트를 하이라이트해줘')?.action?.pageScope, {
    kind: 'range', startPage: 1, endPage: 3
  });
});

test('첨부된 텍스트 변경 예문은 원문과 새 문구를 구분하고 누락 값은 확인한다', () => {
  const corpus = readFileSync(new URL('./fixtures/offline-chat-requests.txt', import.meta.url), 'utf8');
  const section = corpus.split('# 3. 텍스트 일괄 변경 (100개)')[1].split('# 4.')[0];
  const examples = [...section.matchAll(/^(\d{3})\. (.+)$/gm)];
  assert.equal(examples.length, 100);
  for (const [, number, request] of examples) {
    const result = inferDocumentCommand(request);
    if (Number(number) === 76) assert.equal(result?.intent, 'needs-target', `${number}. ${request}`);
    else assert.equal(result?.action?.type, 'batch-replace', `${number}. ${request}`);
  }
  assert.deepEqual(inferDocumentCommand('5페이지부터 끝까지 프로젝트를 사업으로 변경한 뒤 건수를 알려줘')?.action, {
    type: 'batch-replace', originalText: '프로젝트', newText: '사업', all: true, targets: [],
    pageScope: { kind: 'from', startPage: 5 }
  });
  assert.equal(inferDocumentCommand('프로젝트를 사업으로 모두 변경해줘')?.action?.all, true);
  assert.equal(inferDocumentCommand('프로젝트를 사업으로 변경할 항목을 모두 찾아줘')?.action?.all, false);
});

test('보기, 페이지 이동, 확대와 복합 보기 명령을 순서대로 해석한다', () => {
  assert.deepEqual(inferDocumentCommand('문서를 스크롤하면서 볼 수 있게 해줘')?.action?.operations, [
    { command: 'set-view-mode', mode: 'scroll' }
  ]);
  assert.deepEqual(inferDocumentCommand('5페이지로 이동해줘')?.action?.operations, [
    { command: 'go-to-page', page: 5 }
  ]);
  assert.deepEqual(inferDocumentCommand('3페이지로 이동한 뒤 화면을 150%로 확대해줘')?.action?.operations, [
    { command: 'go-to-page', page: 3 },
    { command: 'zoom', value: 1.5 }
  ]);
  assert.deepEqual(inferDocumentCommand('문서를 페이지 이동 모드로 변경하고 페이지 전체가 화면에 보이게 해줘')?.action?.operations, [
    { command: 'set-view-mode', mode: 'page' },
    { command: 'fit', mode: 'page' }
  ]);
});

test('첨부된 보기 제어 예문 100개를 문서 보기 명령으로 구분한다', () => {
  const corpus = readFileSync(new URL('./fixtures/offline-chat-requests.txt', import.meta.url), 'utf8');
  const section = corpus.split('# 4. 문서 보기 및 화면 제어 (100개)')[1].split('# 5.')[0];
  const examples = [...section.matchAll(/^(\d{3})\. (.+)$/gm)];
  assert.equal(examples.length, 100);
  for (const [, number, request] of examples) {
    assert.equal(inferDocumentCommand(request)?.action?.type, 'viewer-command', `${number}. ${request}`);
  }
  assert.deepEqual(inferDocumentCommand('지금보다 20% 더 축소해줘')?.action?.operations, [
    { command: 'zoom', delta: -0.2 }
  ]);
  assert.deepEqual(inferDocumentCommand('스크롤 모드를 해제하고 페이지 이동 모드로 바꿔줘')?.action?.operations, [
    { command: 'set-view-mode', mode: 'page' }
  ]);
});

test('첨부된 다운로드 예문은 형식과 파일명을 추출하고 단독 미리보기 요청을 구분한다', () => {
  const corpus = readFileSync(new URL('./fixtures/offline-chat-requests.txt', import.meta.url), 'utf8');
  const section = corpus.split('# 5. PDF·DOCX 다운로드 (100개)')[1].split('# 6.')[0];
  const examples = [...section.matchAll(/^(\d{3})\. (.+)$/gm)];
  assert.equal(examples.length, 100);
  for (const [, number, request] of examples) {
    const result = inferDocumentCommand(request);
    if ([69, 70, 72, 74, 77, 80].includes(Number(number))) assert.equal(result?.action, null, `${number}. ${request}`);
    else assert.equal(result?.action?.operations?.[0]?.command, 'download', `${number}. ${request}`);
  }
  assert.deepEqual(inferDocumentCommand('최종보고서라는 이름으로 PDF를 만들어줘')?.action?.operations, [
    { command: 'download', format: 'pdf', filename: '최종보고서' }
  ]);
  assert.deepEqual(inferDocumentCommand('원본 파일명 뒤에 _수정본을 붙여 PDF로 다운로드해줘')?.action?.operations, [
    { command: 'download', format: 'pdf', nameSuffix: '_수정본' }
  ]);
});
