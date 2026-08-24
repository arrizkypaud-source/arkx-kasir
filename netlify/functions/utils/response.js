function jsonResponse(code, body, headers = {}) {
  return {
    statusCode: code,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      ...headers
    },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  };
}

function sanitizeStr(s, maxLen = 200) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim().slice(0, maxLen);
}

function validateLogoUrl(url) {
  if (!url) return '';
  if (url.startsWith('data:image/')) return url;
  if (url.startsWith('https://') || url.startsWith('http://')) return url;
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  return '';
}

function todayStr() { return new Date().toISOString().slice(0, 10); }
function dayStr(iso) { return iso.slice(0, 10); }

module.exports = { jsonResponse, sanitizeStr, validateLogoUrl, todayStr, dayStr };
