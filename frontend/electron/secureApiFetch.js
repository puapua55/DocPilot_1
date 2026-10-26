const ALLOWED_API_HOSTS = new Set([
  'api.openai.com',
  'generativelanguage.googleapis.com'
]);

const CONTROL_OR_NON_ASCII = /[\u0000-\u001f\u007f-\uffff]/;

export function validateApiUrl(value) {
  const rawUrl = String(value || '');
  if (!rawUrl || CONTROL_OR_NON_ASCII.test(rawUrl)) {
    throw new Error('허용되지 않은 API 주소입니다.');
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('허용되지 않은 API 주소입니다.');
  }

  if (parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.port
    || !ALLOWED_API_HOSTS.has(parsed.hostname)) {
    throw new Error('허용되지 않은 API 주소입니다.');
  }
  return parsed;
}

export async function secureApiFetch(url, options = {}, fetchImplementation = globalThis.fetch) {
  const validatedUrl = validateApiUrl(url);
  if (typeof fetchImplementation !== 'function') {
    throw new Error('API 통신 기능을 사용할 수 없습니다.');
  }

  const headers = new Headers(options.headers || {});
  // Temporary mitigation for CVE-2026-111497 while no supported stable
  // Electron release contains the patched Node.js runtime. Do not allow an
  // API server to route untrusted Brotli bytes into Node's decoder.
  headers.set('Accept-Encoding', 'identity');

  const response = await fetchImplementation(validatedUrl, {
    ...options,
    headers,
    redirect: 'manual'
  });

  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    throw new Error('API 서버의 리디렉션 응답을 허용하지 않습니다.');
  }

  const contentEncoding = String(response.headers?.get?.('content-encoding') || '').toLowerCase();
  if (contentEncoding.split(',').some((encoding) => encoding.trim() === 'br')) {
    throw new Error('Brotli로 압축된 API 응답을 허용하지 않습니다.');
  }
  return response;
}

export { ALLOWED_API_HOSTS };
