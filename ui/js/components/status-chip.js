import { escapeHtml } from '../utils.js';

export function statusChip(kind = 'unknown', text = 'Inconnu', detail = '') {
  const classes = {
    operational: 'status-operational',
    degraded: 'status-degraded',
    check: 'status-check',
    error: 'status-error',
    unknown: 'status-unknown'
  };
  return `<span class="status-chip ${classes[kind] || classes.unknown}"><span class="dot"></span><span class="text-ellipsis">${escapeHtml(text)}</span>${detail ? `<span class="text-ellipsis">${escapeHtml(detail)}</span>` : ''}</span>`;
}

export function statusBadge(status) {
  const s = (status || '').toLowerCase();
  if (['success', 'completed', 'created', 'pending_activation', 'deleted', 'ok'].includes(s)) return statusChip('operational', status || 'Opérationnel');
  if (['warning', 'partial', 'deferred', 'skipped_active_user'].includes(s)) return statusChip('degraded', status || 'Dégradé');
  if (['error', 'failed', 'blocked_by_passbolt'].includes(s)) return statusChip('error', status || 'Erreur');
  if (['info', 'skipped', 'rollback_required_manual'].includes(s)) return statusChip('check', status || 'À vérifier');
  return statusChip('unknown', status || 'Inconnu');
}
