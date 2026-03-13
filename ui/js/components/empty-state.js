import { escapeHtml } from '../utils.js';
export const emptyState = (msg) => `<div class="empty-state">${escapeHtml(msg)}</div>`;
