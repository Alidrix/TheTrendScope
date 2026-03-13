export async function apiGet(path) {
  const res = await fetch(path);
  const txt = await res.text();
  let payload = {};
  try { payload = txt ? JSON.parse(txt) : {}; } catch { throw new Error(`Réponse invalide (${path})`); }
  if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
  return payload;
}

export async function apiDelete(path) {
  const res = await fetch(path, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Suppression impossible (${res.status})`);
}
