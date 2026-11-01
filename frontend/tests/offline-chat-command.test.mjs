import test from 'node:test';
import assert from 'node:assert/strict';
import { sendChatMessage } from '../src/services/llmService.js';

test('AI OFF에서는 외부 API 없이 로컬 검색 명령을 반환한다', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error('offline mode must not call fetch');
  };
  try {
    const result = await sendChatMessage('문서 2개만 찾아줘', { aiEnabled: false });
    assert.equal(fetchCalled, false);
    assert.deepEqual(result.action, { type: 'search', keyword: '문서', limit: 2, order: null });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AI OFF에서는 로컬 일괄 변경 명령을 해석한다', async () => {
  const result = await sendChatMessage('PDF를 TXT로 바꿔줘', { aiEnabled: false });
  assert.equal(result.action?.type, 'batch-replace');
  assert.equal(result.action?.originalText, 'PDF');
  assert.equal(result.action?.newText, 'TXT');
});

test('AI OFF에서 지원하지 않는 자연어는 오프라인 사용 범위를 안내한다', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => { fetchCalled = true; throw new Error('offline mode must not call fetch'); };
  try {
    const result = await sendChatMessage('이 문서를 요약해줘', { aiEnabled: false });
    assert.equal(fetchCalled, false);
    assert.equal(result.action, null);
    assert.match(result.answer, /오프라인 모드에서 지원하지 않습니다/);
    assert.match(result.answer, /문서 내 문구 검색/);
    assert.match(result.answer, /텍스트 일괄 변경/);
    assert.match(result.answer, /PDF 다운로드/);
    assert.match(result.answer, /PDF를 DOCX로 저장할 수 없음/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('문서 변경 이력 명령은 AI ON에서도 외부 API를 호출하지 않는다', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error('history command must stay local');
  };
  try {
    const undo = await sendChatMessage('이전 상태로 되돌려줘', { aiEnabled: true });
    const reset = await sendChatMessage('전체 초기화해줘', { aiEnabled: true });
    assert.equal(fetchCalled, false);
    assert.deepEqual(undo.action, { type: 'undo' });
    assert.deepEqual(reset.action, { type: 'reset' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('DOCX 화면 맞춤과 PDF의 DOCX 저장은 실행 명령 대신 지원 불가를 안내한다', async () => {
  for (const aiEnabled of [false, true]) {
    const fit = await sendChatMessage('너비 맞춤으로 바꿔줘', { documentType: 'word', aiEnabled });
    const download = await sendChatMessage('DOCX로 다운로드해줘', { documentType: 'pdf', aiEnabled });
    assert.deepEqual({ answer: fit.answer, action: fit.action }, { answer: '지원되지 않는 기능입니다.', action: null });
    assert.deepEqual({ answer: download.answer, action: download.action }, { answer: '지원되지 않는 기능입니다.', action: null });
  }
});

test('PDF 너비 맞춤 요청은 실제 뷰어 명령을 반환한다', async () => {
  const result = await sendChatMessage('너비 맞춤으로 바꿔줘', { documentType: 'pdf', aiEnabled: false });
  assert.deepEqual(result.action?.operations, [{ command: 'fit', mode: 'width' }]);
});
