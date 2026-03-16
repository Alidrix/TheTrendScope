async function parseJsonResponse(res, path) {
  const txt = await res.text();
  if (!txt) return {};
  try {
    return JSON.parse(txt);
  } catch {
    throw new Error(`Réponse invalide (${path})`);
  }
}

export async function apiGet(path) {
  const res = await fetch(path);
  const payload = await parseJsonResponse(res, path);
  if (!res.ok) throw new Error(payload?.error || payload?.message || `HTTP ${res.status}`);
  return payload;
}

export async function apiPost(path, body, options = {}) {
  const res = await fetch(path, {
    method: 'POST',
    body,
    ...options
  });
  const payload = await parseJsonResponse(res, path);
  if (!res.ok) throw new Error(payload?.error || payload?.message || `HTTP ${res.status}`);
  return payload;
}

export async function apiDelete(path) {
  const res = await fetch(path, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Suppression impossible (${res.status})`);
}
