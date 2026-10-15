import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoLinkFontRuns, findHyperlinks, removeHyperlinkFromRuns, safeHyperlink } from '../src/services/hyperlinkService.js';

test('recognizes every requested address type and trims prose punctuation', () => {
  const text = 'https://example.com, http://example.com/path (www.example.com). user@example.com ftp://files.example.com/a mailto:user@example.com';
  assert.deepEqual(findHyperlinks(text).map((link) => link.href), [
    'https://example.com/', 'http://example.com/path', 'https://www.example.com/',
    'mailto:user@example.com', 'ftp://files.example.com/a', 'mailto:user@example.com'
  ]);
  assert.equal(findHyperlinks('https://example.com/a(b)')[0].href, 'https://example.com/a(b)');
  assert.equal(findHyperlinks('일반문장 www. https:// mailto:hello@').length, 0);
  for (const href of ['javascript:alert(1)', 'data:text/html,test', 'file:///C:/secret', 'vbscript:test']) assert.equal(safeHyperlink(href), null);
});

test('links span font runs and survive changes to black text without underline', () => {
  const input = [{ text: 'https://ex', color: '#111111', fontWeight: 'bold' }, { text: 'ample.com plain', color: '#111111' }];
  const linked = autoLinkFontRuns(input);
  assert.equal(linked.map((run) => run.text).join(''), 'https://example.com plain');
  assert.equal(linked.filter((run) => run.hyperlink).length, 2);
  assert.equal(linked[0].hyperlinkId, linked[1].hyperlinkId);
  assert.equal(linked[0].fontWeight, 'bold');
  assert.equal(linked[0].color, '#0000ff');
  assert.equal(linked[0].textDecoration, 'underline');
  assert.equal(linked.at(-1).color, '#111111');
  const styled = autoLinkFontRuns(linked.map((run) => ({ ...run, color: '#000000', textDecoration: 'none' })));
  assert.equal(styled[0].hyperlink, 'https://example.com/');
  assert.equal(styled[0].color, '#000000');
  assert.equal(styled[0].textDecoration, 'none');
});

test('removing one occurrence stays removed through subsequent typing and formatting', () => {
  const linked = autoLinkFontRuns([{ text: 'www.example.com www.example.com' }]);
  const removed = removeHyperlinkFromRuns(linked, linked[0].hyperlinkId);
  const edited = autoLinkFontRuns([...removed, { text: ' more user@example.com' }]);
  assert.equal(edited[0].hyperlink, null);
  assert.equal(edited.filter((run) => run.hyperlink === 'https://www.example.com/').length, 1);
  assert.ok(edited.some((run) => run.hyperlink === 'mailto:user@example.com'));
});

test('text typed after a URL does not inherit the automatic link appearance', () => {
  const linked = autoLinkFontRuns([{ text: 'https://example.com', color: '#222222', textDecoration: 'none' }]);
  const extended = autoLinkFontRuns([{ ...linked[0], text: `${linked[0].text} normal text` }]);
  assert.equal(extended.at(-1).hyperlink, null);
  assert.equal(extended.at(-1).color, '#222222');
  assert.equal(extended.at(-1).textDecoration, 'none');
});
