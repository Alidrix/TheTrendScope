import { escapeHtml } from '../utils.js';

export const dangerZone = (title, _description, actionHtml) => `
  <section class="card danger-zone">
    <div class="section-header">
      <h3>${escapeHtml(title)}</h3>
      <span class="status-chip status-danger"><span class="dot"></span><span>Sensible</span></span>
    </div>
    <div class="mt-2">${actionHtml}</div>
  </section>
`;
