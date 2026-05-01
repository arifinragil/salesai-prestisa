// Lightweight fetch wrapper. Same-origin (no base URL needed).
// All requests include cookies (JWT auth handled by backend's set-cookie).

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const opts = {
    method,
    credentials: 'include',
    headers: { ...headers },
  };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(path, opts);
  let data = null;
  const ct = res.headers.get('content-type') || '';
  try {
    data = ct.includes('application/json') ? await res.json() : await res.text();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const msg = (data && data.message) || `HTTP ${res.status}`;
    throw new ApiError(msg, res.status, data);
  }
  return data;
}

// SWR fetcher convenience
export const fetcher = (path) => api(path);
