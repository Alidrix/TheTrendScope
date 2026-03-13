import { escapeHtml } from '../utils.js';
import { statusChip } from './status-chip.js';

export const healthCard = (item) => `<div class="health-card"><p class="muted text-ellipsis">${escapeHtml(item.label)}</p><div>${item.ok ? statusChip('operational', 'Opérationnel') : statusChip('check', 'À vérifier')}</div><p class="muted text-ellipsis">${escapeHtml(item.detail)}</p></div>`;
