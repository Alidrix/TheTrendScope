import { escapeHtml } from '../utils.js';

export function pageHeader(title, _subtitle, actions = '', extraClass = '') {
  const cls = ['page-header', extraClass].filter(Boolean).join(' ');
  return `
    <header class="${cls}" aria-label="Contexte de vue">
      <p class="page-label text-ellipsis">${escapeHtml(title)}</p>
      ${actions ? `<div class="action-bar">${actions}</div>` : ''}
    </header>
  `;
}
