import { escapeHtml } from '../utils.js';

export const kpiCard = (label, value) => `<div class="kpi-card"><p class="muted text-ellipsis">${escapeHtml(label)}</p><div class="value text-break">${escapeHtml(value)}</div></div>`;
