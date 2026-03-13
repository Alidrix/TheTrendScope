import { escapeHtml } from '../utils.js';

export function pageHeader(title, subtitle, actions = '', extraClass = '') {
  const cardClass = ['card', 'page-header', extraClass].filter(Boolean).join(' ');
  return `<div class="${cardClass}"><div class="min-w-0"><h2 class="text-ellipsis">${escapeHtml(title)}</h2><p class="muted line-clamp-2">${escapeHtml(subtitle)}</p></div><div class="action-bar">${actions}</div></div>`;
}
