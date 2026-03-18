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

function inferLevel(msg = '') {
  const text = String(msg).toLowerCase();
  if (/(erreur|error|échec|failed|indisponible|danger|refus)/.test(text)) return 'error';
  if (/(attention|warning|simulation|dry-run|bloqu|incomplet)/.test(text)) return 'warning';
  if (/(terminé|validé|succès|success|opérationnel)/.test(text)) return 'success';
  return 'info';
}

export function setToast(msg, level) {
  const center = $('notificationCenter');
  if (!center) return;
  const tone = level || inferLevel(msg);
  const item = document.createElement('article');
  item.className = `system-message ${tone}`;
  item.setAttribute('role', 'status');
  item.innerHTML = `<strong>${escapeHtml(msg)}</strong><small>${formatDate(new Date().toISOString())}</small>`;
  center.prepend(item);

  while (center.children.length > 6) center.removeChild(center.lastElementChild);

  setTimeout(() => {
    item.classList.add('fade-out');
    setTimeout(() => item.remove(), 200);
  }, 5200);
}
