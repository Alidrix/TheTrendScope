async function readResponsePayload(res) {
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const text = await res.text();
  if (!text) return { payload: {}, text: '' };

  if (contentType.includes('application/json')) {
    try {
      return { payload: JSON.parse(text), text };
    } catch {
      return { payload: { raw: text }, text };
    }
  }

  try {
    return { payload: JSON.parse(text), text };
  } catch {
    return { payload: { message: text }, text };
  }
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
  if (!res.ok) throw new Error(`Suppression impossible (${res.status})`);
}
