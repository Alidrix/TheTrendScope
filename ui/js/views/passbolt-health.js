import { apiGet } from '../api.js';
import { $, escapeHtml, setToast } from '../utils.js';
import { statusChip } from '../components/status-chip.js';

const STEP_COLORS = {
  success: 'operational',
  warning: 'check',
  error: 'error',
  skipped: 'neutral'
};

function renderStep(step) {
  const tone = STEP_COLORS[step.status] || 'neutral';
  const details = step.details ? `<pre class="json-block">${escapeHtml(JSON.stringify(step.details, null, 2))}</pre>` : '';
  return `
    <div class="health-step health-step-${escapeHtml(step.status || 'skipped')}">
      <div class="health-step-head">
        <strong>${escapeHtml(step.label || step.id)}</strong>
        ${statusChip(tone, step.status || 'skipped')}
      </div>
      <p>${escapeHtml(step.message || '-')}</p>
      ${step.endpoint ? `<p class="muted">Endpoint: ${escapeHtml(step.endpoint)} ${step.http_status ? `(${escapeHtml(step.http_status)})` : ''}</p>` : ''}
      ${step.remediation ? `<p class="muted"><strong>Action recommandée:</strong> ${escapeHtml(step.remediation)}</p>` : ''}
      <details><summary>Détails techniques</summary>${details || '<p class="muted">Aucun détail</p>'}</details>
    </div>
  `;
}

function renderSummary(report) {
  const map = Object.fromEntries((report.steps || []).map((step) => [step.id, step.status]));
  const cell = (label, key) => `<div class="health-pillar"><span>${escapeHtml(label)}</span>${statusChip(STEP_COLORS[map[key]] || 'neutral', map[key] || 'non testé')}</div>`;
  return `
    <div class="health-pillars">
      ${cell('Connectivité', 'network')}
      ${cell('TLS', 'tls')}
      ${cell('Healthcheck statut', 'healthcheck_status')}
      ${cell('Auth verify', 'verify')}
      ${cell('GPG homedir', 'gpg_home')}
      ${cell('Auth JWT', 'jwt_login')}
      ${cell('MFA requis', 'mfa')}
      ${cell('MFA TOTP', 'mfa_totp')}
      ${cell('Groupes API', 'groups')}
      ${cell('Healthcheck détaillé', 'healthcheck')}
    </div>
  `;
}

export function renderPassboltHealthView() {
  $('passboltHealthView').innerHTML = `
    <div class="card">
      <div class="section-header">
        <h3>Santé API Passbolt</h3>
        <button id="runPassboltDiagnostic" class="btn btn-primary">Lancer le diagnostic</button>
      </div>
      <div id="passboltHealthGlobal" class="mt-2"></div>
      <div id="passboltHealthSummary" class="mt-3"></div>
      <div id="passboltHealthSteps" class="mt-3"></div>
    </div>
  `;
  $('runPassboltDiagnostic')?.addEventListener('click', () => refreshPassboltHealth());
}

export async function refreshPassboltHealth() {
  try {
    const report = await apiGet('/api/passbolt/health');
    $('passboltHealthGlobal').innerHTML = statusChip(STEP_COLORS[report.overall_status === 'ok' ? 'success' : report.overall_status] || 'check', `Statut global: ${report.overall_status || 'inconnu'}`);
    $('passboltHealthSummary').innerHTML = renderSummary(report);
    const steps = report.steps || [];
    $('passboltHealthSteps').innerHTML = steps.length ? steps.map(renderStep).join('') : '<div class="soft-empty">Aucune étape retournée par le backend.</div>';

  } catch (error) {
    setToast(`Diagnostic Passbolt indisponible: ${error.message}`);
  }
}
