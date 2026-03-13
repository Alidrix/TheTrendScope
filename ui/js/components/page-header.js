import { escapeHtml } from '../utils.js';

export function pageHeader(title, subtitle, actions = '') {
  return `<div class="card page-header"><div class="min-w-0"><h2 class="text-ellipsis">${escapeHtml(title)}</h2><p class="muted line-clamp-2">${escapeHtml(subtitle)}</p></div><div class="action-bar">${actions}</div></div>`;
}
