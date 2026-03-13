import { escapeHtml } from '../utils.js';

export function pageHeader(title, subtitle, actions = '') {
  return `<div class="card page-header"><div class="min-w-0"><h2 class="text-ellipsis">${escapeHtml(title)}</h2><p class="muted line-clamp-2">${escapeHtml(subtitle)}</p></div><div class="action-bar">${actions}</div></div>`;
}

export function statusChip(kind = 'unknown', text = 'Inconnu', detail = '') {
  const classes = {
    operational: 'status-operational',
    degraded: 'status-degraded',
    check: 'status-check',
    error: 'status-error',
    unknown: 'status-unknown'
  };
  const cls = classes[kind] || classes.unknown;
  const suffix = detail ? `<span class="text-ellipsis">${escapeHtml(detail)}</span>` : '';
  return `<span class="status-chip ${cls}"><span class="dot"></span><span class="text-ellipsis">${escapeHtml(text)}</span>${suffix}</span>`;
}

export function statusBadge(status) {
  const s = (status || '').toLowerCase();
  if (['success', 'completed', 'created', 'pending_activation', 'deleted', 'ok'].includes(s)) return statusChip('operational', status || 'Opérationnel');
  if (['warning', 'partial', 'deferred', 'skipped_active_user'].includes(s)) return statusChip('degraded', status || 'Dégradé');
  if (['error', 'failed', 'blocked_by_passbolt'].includes(s)) return statusChip('error', status || 'Erreur');
  if (['info', 'skipped', 'rollback_required_manual'].includes(s)) return statusChip('check', status || 'À vérifier');
  return statusChip('unknown', status || 'Inconnu');
}

export function emptyState(msg) {
  return `<div class="empty-state">${escapeHtml(msg)}</div>`;
}
