import { apiGet } from '../api.js';
import { $, escapeHtml, setToast } from '../utils.js';
import { statusChip } from '../components/status-chip.js';

const STEP_COLORS = {
  success: 'operational',
  warning: 'degraded',
  error: 'error',
  skipped: 'neutral'
};

const GLOBAL_COLORS = {
  ok: { chip: 'operational', label: 'Opérationnel' },
  warning: { chip: 'degraded', label: 'Partiel' },
  error: { chip: 'error', label: 'Validation échouée' }
};

function kv(label, value) {
  const safe = value === undefined || value === null || value === '' ? '<span class="muted">-</span>' : escapeHtml(typeof value === 'string' ? value : JSON.stringify(value));
  return `<div class="health-kv"><span>${escapeHtml(label)}</span><strong>${safe}</strong></div>`;
}

function renderJwtDeepDiagnostics(step) {
  if (step.id !== 'jwt_login') return '';
  const d = step.details || {};
  return `
    <div class="health-deep-grid mt-2">
      <section class="health-subsection">
        <h4>Préparation</h4>
        ${kv('version envoyée', d.version_sent)}
        ${kv('domain envoyé', d.domain_sent)}
        ${kv('verify_token envoyé', d.verify_token_sent)}
        ${kv('verify_token_expiry envoyé', d.verify_token_expiry_value)}
        ${kv('sha256 JSON brut', d.challenge_json_sha256)}
      </section>
      <section class="health-subsection">
        <h4>Signature</h4>
        ${kv('méthode', d.method)}
        ${kv('mode exact', d.mode)}
        ${kv('trust_model_used', d.trust_model_used)}
        ${kv('fingerprint signature', d.signature_fingerprint)}
        ${kv('code retour', d.gpg_returncode ?? d.returncode)}
      </section>
      <section class="health-subsection">
        <h4>Login JWT</h4>
        ${kv('endpoint', d.endpoint)}
        ${kv('méthode HTTP', d.http_method)}
        ${kv('status HTTP', d.status_http)}
        ${kv('message fonctionnel', d.functional_message)}
      </section>
      <section class="health-subsection">
        <h4>Validation serveur</h4>
        ${kv('access_token présent', d.access_token_present)}
        ${kv('refresh_token présent', d.refresh_token_present)}
        ${kv('verify_token match', d.verify_token_match)}
      </section>
    </div>
    <details class="mt-2"><summary>Détails techniques bruts JWT</summary><pre class="json-block">${escapeHtml(JSON.stringify(d, null, 2))}</pre></details>
  `;
}

function renderStep(step) {
  const tone = STEP_COLORS[step.status] || 'neutral';
  return `
    <div class="health-step health-step-${escapeHtml(step.status || 'skipped')}">
      <div class="health-step-head">
        <strong>${escapeHtml(step.label || step.id)}</strong>
        ${statusChip(tone, step.status || 'skipped')}
      </div>
      <p>${escapeHtml(step.message || '-')}</p>
      ${step.endpoint ? `<p class="muted">Endpoint: ${escapeHtml(step.endpoint)} ${step.http_status ? `(${escapeHtml(step.http_status)})` : ''}</p>` : ''}
      ${step.remediation ? `<p class="muted"><strong>Action recommandée:</strong> ${escapeHtml(step.remediation)}</p>` : ''}
      ${renderJwtDeepDiagnostics(step)}
      <details><summary>Détails techniques bruts</summary><pre class="json-block">${escapeHtml(JSON.stringify(step.details || {}, null, 2))}</pre></details>
    </div>
  `;
}

function renderSummary(report) {
  const map = Object.fromEntries((report.steps || []).map((step) => [step.id, step.status]));
  const cell = (label, key) => `<article class="health-summary-cell"><span class="muted">${escapeHtml(label)}</span>${statusChip(STEP_COLORS[map[key]] || 'neutral', map[key] || 'non testé')}</article>`;
  return `
    <div class="health-summary-grid">
      ${cell('Connectivité', 'network')}
      ${cell('TLS', 'tls')}
      ${cell('Binaire GPG', 'gpg_binary')}
      ${cell('GPG homedir', 'gpg_home')}
      ${cell('Auth verify', 'verify')}
      ${cell('Auth JWT', 'jwt_login')}
      ${cell('verify_token', 'verify_token')}
      ${cell('MFA requise', 'mfa')}
      ${cell('MFA TOTP', 'mfa_totp')}
      ${cell('Groupes API', 'groups')}
      ${cell('Healthcheck détaillés', 'healthcheck')}
    </div>
  `;
}

export function renderPassboltHealthView() {
  $('passboltHealthView').innerHTML = `
    <div class="card">
      <div class="section-header">
        <h3>Diagnostic</h3>
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
  const previousGlobal = $('passboltHealthGlobal')?.innerHTML || '';
  const previousSummary = $('passboltHealthSummary')?.innerHTML || '';
  const previousSteps = $('passboltHealthSteps')?.innerHTML || '';
  try {
    const report = await apiGet('/api/passbolt/health');
    const global = GLOBAL_COLORS[report.overall_status] || { chip: 'unknown', label: 'Non détecté' };
    $('passboltHealthGlobal').innerHTML = `<div class="card"><div class="section-header"><h3>Statut global</h3>${statusChip(global.chip, global.label)}</div></div>`;
    $('passboltHealthSummary').innerHTML = renderSummary(report);
    const steps = report.steps || [];
    $('passboltHealthSteps').innerHTML = steps.length ? steps.map(renderStep).join('') : '<div class="soft-empty">Aucune étape retournée par le backend.</div>';

  } catch (error) {
    if (!$('passboltHealthGlobal')?.innerHTML && previousGlobal) $('passboltHealthGlobal').innerHTML = previousGlobal;
    if (!$('passboltHealthSummary')?.innerHTML && previousSummary) $('passboltHealthSummary').innerHTML = previousSummary;
    if (!$('passboltHealthSteps')?.innerHTML && previousSteps) $('passboltHealthSteps').innerHTML = previousSteps;
    const safeMessage = escapeHtml(error?.message || String(error));
    const errorBlock = `
      <div class="health-step health-step-error">
        <div class="health-step-head">
          <strong>Erreur Python / backend</strong>
          ${statusChip('error', 'error')}
        </div>
        <p>Le diagnostic a rencontré une exception.</p>
        <pre class="json-block">${safeMessage}</pre>
      </div>
    `;
    $('passboltHealthSteps').innerHTML = `${errorBlock}${$('passboltHealthSteps')?.innerHTML || ''}`;
    setToast(`Diagnostic Passbolt indisponible: ${error.message}`, 'error');
  }
}
