async function readResponsePayload(res) {
  if (!res || res.bodyUsed) return { payload: {}, text: '' };
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const text = await res.text();
  if (!text) return { payload: {}, text: '' };

  const tryJson = () => {
    try { return JSON.parse(text); } catch { return null; }
  };

  if (contentType.includes('application/json')) {
    const parsed = tryJson();
    return { payload: parsed ?? { raw: text }, text };
  }

  const parsed = tryJson();
  return { payload: parsed ?? { message: text }, text };
}

function buildHttpError(res, payload, fallback) {
  const message = payload?.error || payload?.message || fallback || `HTTP ${res.status}`;
  return new Error(message);
}

export async function apiGet(path) {
  const res = await fetch(path);
  const { payload } = await readResponsePayload(res);
  if (!res.ok) throw buildHttpError(res, payload, `HTTP ${res.status} (${path})`);
  return payload;
}

export async function apiPost(path, body, options = {}) {
  const res = await fetch(path, {
    method: 'POST',
    body,
    ...options
  });
  const { payload } = await readResponsePayload(res);
  if (!res.ok) throw buildHttpError(res, payload, `HTTP ${res.status} (${path})`);
  return payload;
}

export async function apiDelete(path) {
  const res = await fetch(path, { method: 'DELETE' });
  const { payload } = await readResponsePayload(res);
  if (!res.ok) throw buildHttpError(res, payload, `Suppression impossible (${res.status})`);
}
