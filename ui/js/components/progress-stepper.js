import { escapeHtml } from '../utils.js';

export function renderStepper(containerId, stages, active) {
  const current = stages.indexOf(active);
  document.getElementById(containerId).innerHTML = stages.map((stage, index) => {
    const cls = index < current ? 'done' : index === current ? 'active' : '';
    return `<div class="step ${cls}">${escapeHtml(stage)}</div>`;
  }).join('');
}
