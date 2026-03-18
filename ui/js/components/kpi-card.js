import { escapeHtml } from '../utils.js';

export const kpiCard = (label, value, trend = '') => `
  <article class="kpi-card kpi-card-compact kpi-card--dense">
    <p class="label text-ellipsis-wrap">${escapeHtml(label)}</p>
    <div class="value text-break">${escapeHtml(value)}</div>
    ${trend ? `<p class="trend text-ellipsis-wrap">${escapeHtml(trend)}</p>` : ''}
  </article>
`;
