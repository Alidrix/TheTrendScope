import { escapeHtml } from '../utils.js';

export function renderStepper(containerId, stages, active) {
  const current = stages.indexOf(active);
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = stages.map((stage, index) => {
    const cls = index < current ? 'step done' : index === current ? 'step active' : 'step';
    return `<div class="${cls}">${escapeHtml(stage)}</div>`;
  }).join('');
}
