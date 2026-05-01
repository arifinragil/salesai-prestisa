import { api, ApiError } from '@/lib/api';

beforeEach(() => { global.fetch = jest.fn(); });
afterEach(() => { jest.restoreAllMocks(); });

function mockResponse(body, { status = 200, contentType = 'application/json' } = {}) {
  global.fetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (h === 'content-type' ? contentType : null) },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

test('GET parses JSON body', async () => {
  mockResponse({ ok: true, n: 7 });
  const data = await api('/x');
  expect(data).toEqual({ ok: true, n: 7 });
  expect(fetch).toHaveBeenCalledWith('/x', expect.objectContaining({
    method: 'GET',
    credentials: 'include',
  }));
});

test('POST serializes body and sets content-type', async () => {
  mockResponse({ ok: true });
  await api('/y', { method: 'POST', body: { a: 1 } });
  const opts = fetch.mock.calls[0][1];
  expect(opts.method).toBe('POST');
  expect(opts.headers['Content-Type']).toBe('application/json');
  expect(opts.body).toBe('{"a":1}');
});

test('non-2xx throws ApiError with status', async () => {
  mockResponse({ message: 'no good' }, { status: 401 });
  await expect(api('/z')).rejects.toMatchObject({
    name: 'Error',
    status: 401,
    message: 'no good',
  });
});

test('falls back to "HTTP <status>" when no message', async () => {
  mockResponse('', { status: 500, contentType: 'text/plain' });
  await expect(api('/oops')).rejects.toMatchObject({
    status: 500,
    message: 'HTTP 500',
  });
});

test('ApiError carries body for inspection', async () => {
  mockResponse({ message: 'denied', code: 'X' }, { status: 403 });
  try { await api('/x'); } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect(e.body).toEqual({ message: 'denied', code: 'X' });
  }
});
