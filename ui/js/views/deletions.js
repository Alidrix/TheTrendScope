import { apiGet } from '../api.js';
import { state } from '../state.js';
import { $, escapeHtml, setToast, textCell } from '../utils.js';
import { emptyState } from '../components/empty-state.js';
import { statusChip } from '../components/status-chip.js';

let deleteApiConfigured = false;
let deleteApiMessage = '';
let previewHasEligible = false;
let previewExecuted = false;
let lastRunMode = 'dry-run';
let lastAnalysisPayload = null;
let lastEligibleCount = 0;
let lastBlockingErrors = 0;

const STATUS_META = {
  DRY_RUN_OK: { label: 'Éligible', tone: 'good' },
  DELETED: { label: 'Supprimé', tone: 'good' },
  DELETED_NOT_CONFIRMED: { label: 'Non supprimé côté Passbolt', tone: 'danger' },
  SKIPPED_ADMIN: { label: 'Admin protégé', tone: 'excluded' },
  SKIPPED_NOT_TOOL_MANAGED: { label: 'Exclu', tone: 'excluded' },
  SKIPPED_ACTIVE_USER: { label: 'Blocage métier Passbolt', tone: 'warn' },
  BLOCKED_BY_GROUP_DRY_RUN: { label: 'Blocage dry-run groupe', tone: 'danger' },
  NOT_FOUND: { label: 'Introuvable', tone: 'warn' },
  BLOCKED_BY_PASSBOLT: { label: 'Erreur dry-run', tone: 'danger' },
  ERROR: { label: 'Erreur', tone: 'danger' }
};

export function renderDeletionsView() {
  $('deletionsView').innerHTML = `
    <div id="deleteModeBanner" class="deletion-banner simulation">MODE SIMULATION — aucune suppression réelle n'a été envoyée au serveur.</div>
    <div class="deletion-status-grid">
      <div class="status-mini-card"><span class="label">API Suppression</span><div id="deleteApiMini">${statusChip('check', 'Vérification...')}</div></div>
      <div class="status-mini-card"><span class="label">Batch sélectionné</span><strong id="deleteBatchMini">Dernier import</strong></div>
      <div class="status-mini-card"><span class="label">Dry-run</span><strong id="deleteDryRunMini">Activé</strong></div>
      <div class="status-mini-card"><span class="label">Prévisualisation</span><strong id="deletePreviewMini">Aucune analyse</strong></div>
    </div>

    <div class="card">
      <div class="section-header"><h3>Cible de suppression</h3><p>La suppression est limitée au batch choisi et protège toujours les comptes admin.</p></div>
      <div class="deletion-target-grid">
        <div>
          <label>Batch à analyser</label>
          <select id="deleteBatchSelect"></select>
        </div>
        <div>
          <label>Mode dry-run</label>
          <label id="deleteDryRunToggle" class="toggle-control"><input id="deleteDryRunOnly" type="checkbox" checked/><span class="toggle-slider"></span><span class="toggle-text">Activé</span></label>
        </div>
        <div class="action-bar align-end"><button id="deletePreviewBtn" class="btn btn-secondary">Analyser</button></div>
      </div>
      <div id="deleteTargetSummary" class="deletion-target-summary"></div>
    </div>

    <div class="card">
      <div class="section-header"><h3>Résultat d'analyse</h3></div>
      <div id="deleteAnalysisWrap" class="table-wrap"></div>
    </div>

    <div class="card">
      <div class="section-header"><h3>Synthèse avant action</h3></div>
      <div id="deleteSynthesis" class="deletion-synthesis-grid"></div>
      <div id="deleteOutcomeBanner" class="deletion-banner info">Aucune exécution réalisée.</div>
    </div>

    <div class="card controlled-action-card">
      <div class="section-header"><h3>Exécution contrôlée</h3><p>Action sensible : exécution réelle uniquement après dry-run valide.</p></div>
      <label class="confirm-control"><input id="deleteConfirm" type="checkbox"/> Je confirme vouloir lancer la suppression réelle des comptes éligibles.</label>
      <div class="action-bar mt-3"><button id="deleteExecuteBtn" class="btn btn-danger" disabled>Lancer la suppression réelle</button></div>
      <p class="muted mt-3">Sécurité : les admins et les exclusions sont automatiquement ignorés côté backend.</p>
    </div>

    <details class="card technical-logs" open>
      <summary>Journal / détails techniques</summary>
      <pre id="deleteTechLogs" class="console mt-3"></pre>
    </details>
  `;

  updateDryRunToggle();
  $('deleteDryRunOnly').addEventListener('change', updateDryRunToggle);
  $('deleteBatchSelect').addEventListener('change', updateBatchMini);
  $('deletePreviewBtn').addEventListener('click', () => runDeleteStream(true));
  $('deleteExecuteBtn').addEventListener('click', () => runDeleteStream(false));
  $('deleteConfirm').addEventListener('change', refreshExecuteButtonState);
  renderEmptyAnalysis();
}

function updateDryRunToggle() {
  const checked = $('deleteDryRunOnly')?.checked;
  $('deleteDryRunToggle')?.classList.toggle('off', !checked);
  const text = $('deleteDryRunToggle')?.querySelector('.toggle-text');
  if (text) text.textContent = checked ? 'Activé' : 'Désactivé';
  $('deleteDryRunMini').textContent = checked ? 'Activé' : 'Désactivé';
  const modeBanner = $('deleteModeBanner');
  if (modeBanner) {
    modeBanner.className = `deletion-banner ${checked ? 'simulation' : 'real'}`;
    modeBanner.textContent = checked
      ? "MODE SIMULATION — aucune suppression réelle n'a été envoyée au serveur."
      : 'MODE SUPPRESSION RÉELLE — la suppression sera envoyée à Passbolt après confirmation.';
  }
  refreshExecuteButtonState();
}

function updateBatchMini() {
  const value = $('deleteBatchSelect')?.value;
  const label = value && value !== '__latest__' ? value : 'Dernier import';
  $('deleteBatchMini').textContent = label;
}

function appendTechLog(line) {
  const block = $('deleteTechLogs');
  if (!block) return;
  block.textContent += `${line}\n`;
  block.scrollTop = block.scrollHeight;
}

function renderEmptyAnalysis() {
  lastAnalysisPayload = null;
  lastEligibleCount = 0;
  lastBlockingErrors = 0;
  previewHasEligible = false;
  previewExecuted = false;
  $('deleteAnalysisWrap').innerHTML = emptyState('Aucun batch analysé. Choisissez un batch puis lancez « Analyser ».');
  $('deleteSynthesis').innerHTML = '<div class="soft-empty">Exécutez un dry-run pour voir les comptes supprimables et les exclusions.</div>';
  $('deleteTargetSummary').innerHTML = '<div class="soft-empty">Aucune analyse en cours.</div>';
  $('deletePreviewMini').textContent = 'Aucune analyse';
}

function mapRowReason(row) {
  return row.exclusion_reason || row.message || '-';
}

function renderRows(rows) {
  if (!rows.length) {
    $('deleteAnalysisWrap').innerHTML = emptyState('Aucun utilisateur trouvé pour ce batch.');
    return;
  }
  const html = rows.map((row) => {
    const meta = STATUS_META[row.status] || { label: row.status || 'Inconnu', tone: 'neutral' };
    return `<tr>
      <td>${textCell(row.email)}</td>
      <td>${textCell(row.role || row.requested_role || '-')}</td>
      <td>${textCell(row.batch_uuid, 'text-ellipsis')}</td>
      <td><span class="eligibility-tag ${meta.tone}">${meta.label}</span></td>
      <td>${textCell(mapRowReason(row))}</td>
      <td>${textCell(row.dry_run_status || '-')}</td>
      <td>${textCell(row.dry_run_details || '-')}</td>
      <td>${row.final_action_allowed ? '<span class=\"eligibility-tag good\">Autorisée</span>' : '<span class=\"eligibility-tag neutral\">Bloquée</span>'}</td>
      <td>${row.final_action === 'real_delete_confirmed'
        ? '<span class="eligibility-tag good">Supprimé sur Passbolt</span>'
        : row.final_action === 'real_delete_not_confirmed'
          ? '<span class="eligibility-tag danger">Non supprimé côté Passbolt</span>'
          : row.final_action === 'real_delete_requested'
            ? '<span class="eligibility-tag warn">Suppression demandée</span>'
            : '<span class="eligibility-tag neutral">Simulation</span>'}</td>
    </tr>`;
  }).join('');
  $('deleteAnalysisWrap').innerHTML = `<table><thead><tr><th>Email</th><th>Rôle</th><th>Batch</th><th>Statut</th><th>Raison</th><th>Dry-run</th><th>Détails dry-run</th><th>Action</th><th>Résultat Passbolt</th></tr></thead><tbody>${html}</tbody></table>`;
}

function renderSummary(payload) {
  const rows = payload.results || [];
  const summary = payload.summary || {};
  const admins = summary.admins_protected ?? rows.filter((r) => r.status === 'SKIPPED_ADMIN').length;
  const eligible = summary.eligible ?? rows.filter((r) => r.eligible).length;
  const excluded = summary.excluded ?? rows.filter((r) => !r.eligible).length;
  const errors = summary.errors ?? rows.filter((r) => ['ERROR', 'BLOCKED_BY_PASSBOLT'].includes(r.status)).length;
  const hasDeletableStatus = rows.some((r) => r.status === 'DRY_RUN_OK' || r.eligible === true);

  lastAnalysisPayload = payload;
  lastEligibleCount = eligible;
  lastBlockingErrors = errors;
  previewHasEligible = hasDeletableStatus && eligible > 0;
  $('deletePreviewMini').textContent = `${eligible} éligibles / ${excluded} exclus`;
  $('deleteTargetSummary').innerHTML = `
    <div class="deletion-target-pill">Lignes batch: <strong>${payload.total || rows.length}</strong></div>
    <div class="deletion-target-pill">Utilisateurs trouvés: <strong>${rows.filter((r) => r.found).length}</strong></div>
    <div class="deletion-target-pill ok">Supprimables: <strong>${eligible}</strong></div>
    <div class="deletion-target-pill warn">Exclus: <strong>${excluded}</strong></div>
    <div class="deletion-target-pill neutral">Admins protégés: <strong>${admins}</strong></div>
  `;
  $('deleteSynthesis').innerHTML = `
    <div class="synthesis-item"><span>Utilisateurs analysés</span><strong>${summary.analyzed ?? rows.length}</strong></div>
    <div class="synthesis-item"><span>Supprimables</span><strong>${eligible}</strong></div>
    <div class="synthesis-item"><span>Exclus automatiquement</span><strong>${excluded}</strong></div>
    <div class="synthesis-item"><span>Admins protégés</span><strong>${admins}</strong></div>
    <div class="synthesis-item"><span>Erreurs / blocages</span><strong>${errors}</strong></div>
  `;
  const confirmed = rows.filter((r) => r.final_action === 'real_delete_confirmed').length;
  const notConfirmed = rows.filter((r) => r.final_action === 'real_delete_not_confirmed').length;
  const outcome = $('deleteOutcomeBanner');
  if (outcome) {
    if (lastRunMode === 'dry-run') {
      outcome.className = 'deletion-banner simulation';
      outcome.textContent = 'Simulation uniquement : aucune suppression réelle n’a été envoyée.';
    } else if (confirmed > 0 && notConfirmed === 0) {
      outcome.className = 'deletion-banner success';
      outcome.textContent = 'Suppression confirmée : utilisateur absent après contrôle.';
    } else if (notConfirmed > 0) {
      outcome.className = 'deletion-banner danger';
      outcome.textContent = 'Suppression refusée par Passbolt : utilisateur encore présent.';
    } else {
      outcome.className = 'deletion-banner info';
      outcome.textContent = 'Suppression réelle envoyée à Passbolt.';
    }
  }
}

function refreshExecuteButtonState() {
  const dryRunChecked = Boolean($('deleteDryRunOnly')?.checked);
  const confirmationChecked = Boolean($('deleteConfirm')?.checked);
  const rows = lastAnalysisPayload?.results || [];
  const hasDeletableStatus = rows.some((r) => r.status === 'DRY_RUN_OK' || r.eligible === true);
  const canExecute = previewExecuted
    && !dryRunChecked
    && confirmationChecked
    && lastEligibleCount > 0
    && lastBlockingErrors === 0
    && Boolean(lastAnalysisPayload)
    && hasDeletableStatus
    && previewHasEligible;
  $('deleteExecuteBtn').disabled = !canExecute;
}

export async function refreshDeleteConfig() {
  try {
    const [cfg, batches] = await Promise.all([
      apiGet('/api/delete-config-status').catch(() => ({})),
      apiGet('/api/batches').catch(() => ({ items: [] }))
    ]);
    deleteApiConfigured = Boolean(cfg.configured);
    deleteApiMessage = cfg.message || '';
    $('deleteApiMini').innerHTML = deleteApiConfigured
      ? statusChip('check', 'Configurée (diagnostic requis)')
      : statusChip('error', 'À configurer', deleteApiMessage);
    $('deleteBatchSelect').innerHTML = `<option value="__latest__">Dernier import</option>${(batches.items || []).map((b) => `<option value="${escapeHtml(b.batch_uuid)}">${escapeHtml(b.batch_uuid)} — ${escapeHtml(b.filename || 'Sans fichier')}</option>`).join('')}`;
    updateBatchMini();
    refreshExecuteButtonState();
  } catch (e) {
    setToast(`Configuration suppression indisponible: ${e.message}`);
  }
}

async function runDeleteStream(previewOnly) {
  const dryRunState = Boolean($('deleteDryRunOnly')?.checked);
  const confirmationChecked = Boolean($('deleteConfirm')?.checked);
  const rows = lastAnalysisPayload?.results || [];
  const hasDeletableStatus = rows.some((r) => r.status === 'DRY_RUN_OK' || r.eligible === true);
  const effectiveDryRun = previewOnly ? true : dryRunState;
  const selected = $('deleteBatchSelect').value;
  const body = { dry_run_only: effectiveDryRun };
  if (selected && selected !== '__latest__') body.batch_uuid = selected;
  body.ui_dry_run_state = dryRunState;
  body.confirmation_checked = confirmationChecked;
  body.eligible_count = lastEligibleCount;
  body.blocking_errors = lastBlockingErrors;
  body.has_deletable_status = hasDeletableStatus;
  lastRunMode = body.dry_run_only ? 'dry-run' : 'real-delete';

  $('deletePreviewBtn').disabled = true;
  $('deleteExecuteBtn').disabled = true;
  $('deleteTechLogs').textContent = '';
  appendTechLog(
    `UI | ${JSON.stringify({
      ui_dry_run_state: dryRunState,
      backend_dry_run_state: effectiveDryRun,
      confirmation_checked: confirmationChecked,
      eligible_count: lastEligibleCount,
      blocking_errors: lastBlockingErrors,
      has_deletable_status: hasDeletableStatus,
      final_action: effectiveDryRun ? 'simulation_only' : (confirmationChecked ? 'real_delete_requested' : 'real_delete_not_confirmed')
    }, null, 0)}`
  );

  try {
    const res = await fetch('/api/delete-users-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok || !res.body) throw new Error('Flux suppression indisponible');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (['log', 'stderr', 'stdout'].includes(event.type)) appendTechLog(`${event.type.toUpperCase()} | ${event.message}`);
        if (event.type === 'final') {
          const payload = event.payload || {};
          appendTechLog(
            `FINAL | ${JSON.stringify({
              ui_dry_run_state: dryRunState,
              backend_dry_run_state: Boolean(payload.dry_run_only),
              confirmation_checked: confirmationChecked,
              eligible_count: lastEligibleCount,
              endpoint_called: (payload.results || []).map((r) => r.endpoint_called).filter(Boolean),
              http_method: (payload.results || []).map((r) => r.http_method).filter(Boolean),
              http_status: (payload.results || []).map((r) => r.http_status).filter((s) => s !== undefined),
              final_action: (payload.results || []).map((r) => r.final_action),
            }, null, 0)}`
          );
          state.deletePreviewDone = true;
          previewExecuted = true;
          renderRows(payload.results || []);
          renderSummary(payload);
          refreshExecuteButtonState();
        }
      }
    }

    if (!previewOnly) {
      $('deleteConfirm').checked = false;
      previewExecuted = false;
      previewHasEligible = false;
      lastAnalysisPayload = null;
      lastEligibleCount = 0;
      lastBlockingErrors = 0;
      refreshExecuteButtonState();
      setToast('Suppression réelle terminée.');
    }
  } catch (e) {
    setToast(`Erreur suppression: ${e.message}`);
  } finally {
    $('deletePreviewBtn').disabled = false;
    refreshExecuteButtonState();
  }
}
