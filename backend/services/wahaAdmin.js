const BASE = () => process.env.WAHA_API_URL || 'http://localhost:3000';
const KEY = () => process.env.WAHA_API_KEY || '';

function headers(extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  if (KEY()) h['X-Api-Key'] = KEY();
  return h;
}

async function callJson(method, path, body) {
  const res = await fetch(`${BASE()}${path}`, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const ct = res.headers.get('content-type') || '';
  try {
    data = ct.includes('application/json') ? await res.json() : await res.text();
  } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

async function listSessions() { return callJson('GET', '/api/sessions'); }

async function createSession(name) {
  return callJson('POST', '/api/sessions', { name });
}

async function startSession(name)   { return callJson('POST', `/api/sessions/${encodeURIComponent(name)}/start`); }
async function stopSession(name)    { return callJson('POST', `/api/sessions/${encodeURIComponent(name)}/stop`); }
async function restartSession(name) { return callJson('POST', `/api/sessions/${encodeURIComponent(name)}/restart`); }
async function deleteSession(name)  { return callJson('DELETE', `/api/sessions/${encodeURIComponent(name)}`); }
async function getSessionDetails(name) { return callJson('GET', `/api/sessions/${encodeURIComponent(name)}`); }

async function getSessionQr(name) {
  const tryPath = async (path) => {
    const res = await fetch(`${BASE()}${path}`, { method: 'GET', headers: headers() });
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok) {
      let detailText = '';
      try { detailText = await res.text(); } catch {}
      return { ok: false, status: res.status, body: null, contentType, detail: detailText };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: true, status: 200, body: buf, contentType };
  };

  const modern = `/api/${encodeURIComponent(name)}/auth/qr?format=image`;
  const legacy = `/api/sessions/${encodeURIComponent(name)}/auth/qr?format=image`;
  let r = await tryPath(modern);
  if (r.status === 404) r = await tryPath(legacy);
  return r;
}

const VALID_NAME = /^[a-zA-Z0-9_-]{2,64}$/;
function isValidSessionName(name) { return VALID_NAME.test(String(name || '')); }

module.exports = {
  listSessions, createSession, startSession, stopSession, restartSession,
  deleteSession, getSessionDetails, getSessionQr, isValidSessionName,
};
