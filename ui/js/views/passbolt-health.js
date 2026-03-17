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
  ok: { chip: 'operational', label: 'Opérationnel de bout en bout' },
  warning: { chip: 'degraded', label: 'Testé partiellement' },
  error: { chip: 'error', label: 'Validation échouée' }
};


function kv(label, value) {
  const safe = value === undefined || value === null || value === '' ? '<span class="muted">-</span>' : escapeHtml(typeof value === 'string' ? value : JSON.stringify(value));
  return `<div class="health-kv"><span>${escapeHtml(label)}</span><strong>${safe}</strong></div>`;
}

function renderJwtDeepDiagnostics(step) {
  if (step.id !== 'jwt_login') return '';
  const d = step.details || {};
  const summaryText = d.recipient_trust_error
    ? 'Clé serveur refusée par GPG faute de trust · Flow applicatif rejeté avant login JWT'
    : (d.status_http && d.status_http < 400
      ? 'Crypto locale OK · Flow JWT applicatif accepté (login 200)'
      : 'Crypto locale OK · Flow manuel accepté / flow applicatif rejeté');

  return `
    <div class="health-deep-grid mt-2">
      <section class="health-subsection">
        <h4>A. Préparation du challenge</h4>
        ${kv('version envoyée', d.version_sent)}
        ${kv('domain envoyé', d.domain_sent)}
        ${kv('verify_token envoyé', d.verify_token_sent)}
        ${kv('verify_token_expiry envoyé', d.verify_token_expiry_value)}
        ${kv('type verify_token_expiry', d.verify_token_expiry_type)}
        ${kv('taille JSON brut', d.challenge_json_size)}
        ${kv('sha256 JSON brut', d.challenge_json_sha256)}
        ${kv('dump JSON brut', d.challenge_json_dump_path)}
      </section>
      <section class="health-subsection">
        <h4>B. Signature</h4>
        ${kv('méthode', d.method)}
        ${kv('mode exact', d.mode)}
        ${kv('arguments GPG', d.gpg_args)}
        ${kv('trust_model_used', d.trust_model_used)}
        ${kv('fingerprint signature', d.signature_fingerprint)}
        ${kv('fingerprint destinataire serveur', d.server_key_fingerprint)}
        ${kv('source clé destinataire', d.server_key_source)}
        ${kv('taille challenge final', d.app_challenge_size)}
        ${kv('sha256 challenge final', d.app_challenge_sha256)}
        ${kv('header armor détecté', d.challenge_armor_header_detected)}
        ${kv('footer armor détecté', d.challenge_armor_footer_detected)}
        ${kv('stdout GPG', d.gpg_stdout || d.stdout)}
        ${kv('stderr GPG', d.gpg_stderr || d.stderr)}
        ${kv('code retour', d.gpg_returncode ?? d.returncode)}
        ${kv('erreur trust recipient', d.recipient_trust_error)}
        ${kv('message erreur trust', d.trust_error_message)}
      </section>
      <section class="health-subsection">
        <h4>C. Chiffrement</h4>
        ${kv('fingerprint attendu', d.fingerprint_attendu)}
        ${kv('fingerprint importé', d.fingerprint_importe)}
        ${kv('fingerprint sélectionné', d.fingerprint_selectionne)}
        ${kv('clé importée', d.key_imported)}
        ${kv('clé sélectionnée', d.key_selected)}
        ${kv('source clé serveur', d.server_key_source)}
        ${kv('fingerprint serveur', d.server_key_fingerprint)}
        ${kv('erreur recipient trust', d.recipient_trust_error)}
        ${kv('taille challenge final', d.app_challenge_size)}
        ${kv('sha256 challenge final', d.app_challenge_sha256)}
        ${kv('header armor détecté', d.challenge_armor_header_detected)}
        ${kv('footer armor détecté', d.challenge_armor_footer_detected)}
        ${kv('dump final', d.challenge_final_dump_path)}
      </section>
      <section class="health-subsection">
        <h4>D. Login JWT</h4>
        ${kv('endpoint', d.endpoint)}
        ${kv('méthode HTTP', d.http_method)}
        ${kv('requests.post(..., json=...)', d.uses_requests_post_json)}
        ${kv('body size', d.body_json_size)}
        ${kv('sha256 body JSON envoyé', d.body_json_sha256)}
        ${kv('dump body', d.body_dump_path)}
        ${kv('challenge envoyé = dump final', d.challenge_sent_equals_dump)}
        ${kv('challenge altéré après debug', d.challenge_altered_after_debug)}
        ${kv('newline normalized', d.challenge_newline_normalized)}
        ${kv('trimmed', d.challenge_trimmed)}
        ${kv('double json dumps', d.double_json_dumps)}
        ${kv('extra base64', d.extra_base64)}
        ${kv('status HTTP', d.status_http)}
        ${kv('message fonctionnel', d.functional_message)}
      </section>
      <section class="health-subsection">
        <h4>E. Validation réponse serveur</h4>
        ${kv('dump body.challenge serveur', d.server_challenge_dump_path)}
        ${kv('verify_token retourné', d.verify_token_returned)}
        ${kv('verify_token match', d.verify_token_match)}
        ${kv('access_token présent', d.access_token_present)}
        ${kv('refresh_token présent', d.refresh_token_present)}
        ${kv('providers', d.providers)}
      </section>
      <section class="health-subsection">
        <h4>Comparatif manuel vs applicatif</h4>
        ${kv('challenge_manual_status', d.challenge_manual_status)}
        ${kv('challenge_app_status', d.challenge_app_status)}
        ${kv('sha256 challenge manuel', d.manual_challenge_sha256)}
        ${kv('sha256 challenge applicatif', d.app_challenge_sha256)}
        ${kv('taille challenge manuel', d.manual_challenge_size)}
        ${kv('taille challenge applicatif', d.app_challenge_size)}
        ${kv('body JSON manuel sha256', d.manual_body_json_sha256)}
        ${kv('body JSON applicatif sha256', d.app_body_json_sha256)}
        ${kv('même body HTTP ?', d.same_http_body)}
        ${kv('même challenge final ?', d.same_final_challenge)}
        ${kv('challenge applicatif identique au challenge envoyé', d.challenge_app_identical_to_sent)}
        ${kv('différence détectée', d.difference_detected)}
        ${kv('résumé humain', d.human_summary)}
      </section>
    </div>
    <p class="mt-2"><strong>Synthèse:</strong> ${escapeHtml(summaryText)}</p>
    <p class="muted">Réponse brute complète:</p>
    <pre class="json-block">${escapeHtml(d.response_body_raw || '')}</pre>
  `;
}

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
      ${renderJwtDeepDiagnostics(step)}
      <details><summary>Détails techniques bruts</summary>${details || '<p class="muted">Aucun détail</p>'}</details>
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
      ${cell('Binaire GPG', 'gpg_binary')}
      ${cell('GPG homedir', 'gpg_home')}
      ${cell('Auth verify', 'verify')}
      ${cell('Auth JWT', 'jwt_login')}
      ${cell('verify_token', 'verify_token')}
      ${cell('MFA requise', 'mfa')}
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
    const global = GLOBAL_COLORS[report.overall_status] || { chip: 'unknown', label: 'Non détecté' };
    $('passboltHealthGlobal').innerHTML = statusChip(global.chip, `Statut global: ${global.label}`, report.overall_status || 'inconnu');
    $('passboltHealthSummary').innerHTML = renderSummary(report);
    const steps = report.steps || [];
    $('passboltHealthSteps').innerHTML = steps.length ? steps.map(renderStep).join('') : '<div class="soft-empty">Aucune étape retournée par le backend.</div>';

  } catch (error) {
    setToast(`Diagnostic Passbolt indisponible: ${error.message}`);
  }
}
