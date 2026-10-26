import assert from 'node:assert/strict';
import test from 'node:test';
import { chatWithGemini } from '../electron/geminiService.js';
import { chatWithOpenAi } from '../electron/openaiService.js';
import { secureApiFetch, validateApiUrl } from '../electron/secureApiFetch.js';

test('only fixed HTTPS API hosts are allowed', () => {
  assert.equal(validateApiUrl('https://api.openai.com/v1/responses').hostname, 'api.openai.com');
  assert.equal(validateApiUrl('https://generativelanguage.googleapis.com/v1beta/models/test').hostname, 'generativelanguage.googleapis.com');
  assert.throws(() => validateApiUrl('http://api.openai.com/v1/responses'), /허용되지 않은/);
  assert.throws(() => validateApiUrl('https://api.openai.com.evil.example/v1/responses'), /허용되지 않은/);
  assert.throws(() => validateApiUrl('https://api.openai.com\0.evil.example/v1/responses'), /허용되지 않은/);
  assert.throws(() => validateApiUrl('https://１２７.0.0.1/v1/responses'), /허용되지 않은/);
  assert.throws(() => validateApiUrl('https://0127.0.0.1/v1/responses'), /허용되지 않은/);
});

test('requests identity encoding and refuses redirects', async () => {
  let received;
  const fakeFetch = async (url, options) => {
    received = { url, options };
    return new Response(null, { status: 302, headers: { location: 'https://evil.example/' } });
  };

  await assert.rejects(
    secureApiFetch('https://api.openai.com/v1/responses', { method: 'POST' }, fakeFetch),
    /리디렉션/
  );
  assert.equal(received.url.hostname, 'api.openai.com');
  assert.equal(received.options.redirect, 'manual');
  assert.equal(received.options.headers.get('accept-encoding'), 'identity');
});

test('refuses Brotli responses before consuming the body', async () => {
  const fakeFetch = async () => new Response('compressed bytes', {
    status: 200,
    headers: { 'content-encoding': 'br' }
  });

  await assert.rejects(
    secureApiFetch('https://generativelanguage.googleapis.com/v1beta/models/test', {}, fakeFetch),
    /Brotli/
  );
});

test('returns normal uncompressed API responses', async () => {
  const fakeFetch = async () => new Response('{"ok":true}', {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
  const response = await secureApiFetch('https://api.openai.com/v1/responses', {}, fakeFetch);
  assert.deepEqual(await response.json(), { ok: true });
});

test('Gemini and OpenAI requests keep their fixed hosts and API authentication', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), headers: options.headers });
    if (String(url).includes('googleapis.com')) {
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"answer":"ok","intent":"search","action":{"type":"search","keyword":"test"}}' }] } }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      output: [{ content: [{ type: 'output_text', text: '{"answer":"ok","intent":"search","action":{"type":"search","keyword":"test"}}' }] }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    assert.equal((await chatWithGemini({ message: 'test' }, { geminiApiKey: 'gemini-secret' })).intent, 'search');
    assert.equal((await chatWithOpenAi({ message: 'test' }, { openAiApiKey: 'openai-secret' })).intent, 'search');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 2);
  assert.equal(new URL(requests[0].url).hostname, 'generativelanguage.googleapis.com');
  assert.equal(requests[0].headers.get('x-goog-api-key'), 'gemini-secret');
  assert.equal(requests[0].headers.get('accept-encoding'), 'identity');
  assert.equal(new URL(requests[1].url).hostname, 'api.openai.com');
  assert.equal(requests[1].headers.get('authorization'), 'Bearer openai-secret');
  assert.equal(requests[1].headers.get('accept-encoding'), 'identity');
});
