import { escapeHtml } from '../utils.js';

export function pageHeader(title, _subtitle, actions = '', extraClass = '') {
  const cls = ['page-header', 'card', extraClass].filter(Boolean).join(' ');
  return `
    <header class="${cls}">
      <div class="min-w-0">
        <h2 class="text-ellipsis">${escapeHtml(title)}</h2>
      </div>
      ${actions ? `<div class="action-bar">${actions}</div>` : ''}
    </header>
  `;
}
