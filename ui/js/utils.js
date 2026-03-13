export function $(id) { return document.getElementById(id); }
export function escapeHtml(v) { return (v || '').toString().replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])); }
export function formatDate(v) {
  if (!v) return '-';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString('fr-FR');
}
export function textCell(value, cls = 'text-break') {
  return `<span class="${cls}">${escapeHtml(value || '-')}</span>`;
}

export function setToast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 2800);
}
