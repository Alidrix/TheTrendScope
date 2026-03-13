import { state, STAGES } from './state.js';
import { $, escapeHtml, formatDate, setToast, textCell } from './utils.js';
import { apiDelete, apiGet } from './api.js';
import { emptyState, pageHeader, statusBadge, statusChip } from './components/ui.js';

function switchView(viewId) {
  state.view = viewId;
  document.querySelectorAll('.menu-item').forEach((a) => a.classList.toggle('active', a.dataset.view === viewId));
  document.querySelectorAll('.view-section').forEach((v) => v.classList.toggle('active-view', v.id === viewId));
  if (viewId === 'dashboardView') refreshDashboard();
  if (viewId === 'historyView') refreshHistory();
  if (viewId === 'logsAuditView') refreshLogs();
  if (viewId === 'deletionsView') refreshDeleteConfig();
}

function renderDashboardSkeleton() {
  $('dashboardView').innerHTML = `
    ${pageHeader('Dashboard', 'Supervision opérationnelle des imports, suppressions et alertes.', '<button id="dashboardRefresh" class="btn btn-secondary">Rafraîchir</button>')}
    <div class="grid-health" id="healthGrid"></div>
    <div class="grid-kpi" id="kpiGrid"></div>
    <div class="grid-three">
      <div class="card"><div class="section-header"><h3>Dernier import</h3></div><div id="lastImportBlock"></div></div>
      <div class="card"><div class="section-header"><h3>Alertes récentes</h3></div><div id="alertsBlock"></div></div>
      <div class="card"><div class="section-header"><h3>Activité récente</h3></div><div id="activityBlock"></div></div>
    </div>`;
  $('dashboardRefresh').addEventListener('click', refreshDashboard);
}

async function refreshDashboard() {
  try {
    const [health, deleteCfg, dbSummary, batches, logsSummary] = await Promise.all([
      apiGet('/api/health').catch(() => ({})),
      apiGet('/api/delete-config-status').catch(() => ({})),
      apiGet('/api/db/summary').catch(() => ({})),
      apiGet('/api/batches').catch(() => ({ items: [] })),
      apiGet('/api/logs/summary').catch(() => ({}))
    ]);
    state.batches = batches?.items || [];
    const latest = dbSummary?.last_batch || state.batches[0] || null;

    const healthCards = [
      { label: 'API Import', ok: Boolean(health?.ok), detail: health?.resolved_container || 'Non détecté' },
      { label: 'Delete API', ok: Boolean(deleteCfg?.configured), detail: deleteCfg?.message || 'Configuration à vérifier' },
      { label: 'Base locale', ok: true, detail: `${dbSummary?.batches_count || 0} batch(es)` },
      { label: 'Passbolt / CLI', ok: Boolean(health?.resolved_cli_path), detail: health?.resolved_cli_path || 'Chemin inconnu' }
    ];

    $('healthGrid').innerHTML = healthCards.map((h) => `<div class="health-card"><p class="muted text-ellipsis">${escapeHtml(h.label)}</p><div>${h.ok ? statusChip('operational', 'Opérationnel') : statusChip('check', 'À vérifier')}</div><p class="muted text-ellipsis">${escapeHtml(h.detail)}</p></div>`).join('');

    const today = new Date().toDateString();
    const kpis = [
      ['Imports aujourd’hui', state.batches.filter((b) => new Date(b.created_at).toDateString() === today).length],
      ['Utilisateurs créés', latest?.success_count || 0],
      ['Groupes assignés', latest?.group_assignments || 0],
      ['Erreurs 24h', logsSummary?.by_level?.error || 0],
      ['Batches enregistrés', dbSummary?.batches_count || 0],
      ['Candidats supprimables', dbSummary?.deletable_candidates_count || 0]
    ];
    $('kpiGrid').innerHTML = kpis.map(([label, value]) => `<div class="kpi-card"><p class="muted text-ellipsis">${label}</p><div class="value text-ellipsis">${escapeHtml(value)}</div></div>`).join('');

    $('lastImportBlock').innerHTML = latest
      ? `<p class="text-ellipsis"><strong>${escapeHtml(latest.filename || '-')}</strong></p><p class="muted text-ellipsis">${formatDate(latest.created_at)}</p><p>${statusBadge(latest.status)}</p><p class="muted text-break">Batch: ${escapeHtml(latest.batch_uuid || '-')}</p>`
      : emptyState('Aucun import enregistré.');

    const alerts = [
      logsSummary?.by_level?.error ? `${logsSummary.by_level.error} erreur(s) critiques` : '',
      !deleteCfg?.configured ? 'Delete API non configurée' : '',
      !health?.ok ? 'API Import indisponible' : ''
    ].filter(Boolean);
    $('alertsBlock').innerHTML = alerts.length ? alerts.map((a) => `<p class="line-clamp-2 text-break">• ${escapeHtml(a)}</p>`).join('') : emptyState('Aucune alerte majeure.');

    $('activityBlock').innerHTML = state.batches.slice(0, 5).map((b) => `<div class="mb-3"><p class="text-ellipsis"><strong>${escapeHtml(b.filename || 'Sans nom')}</strong></p><p class="muted text-ellipsis">${formatDate(b.created_at)}</p></div>`).join('') || emptyState('Aucune activité récente.');
  } catch (e) { setToast(`Dashboard indisponible: ${e.message}`); }
}

function renderImporterSkeleton() {
  $('importerView').innerHTML = `
    ${pageHeader('Importer', 'Workflow guidé pour un import CSV robuste et traçable.')}
    <div class="grid-two">
      <div class="card">
        <div class="section-header"><h3>Dépôt CSV</h3><p>1 fichier = 1 batch</p></div>
        <div class="drop-zone"><input id="importFile" type="file" accept=".csv"/></div>
        <div class="form-grid mt-3">
          <div><label>Nom de lot (optionnel)</label><input id="importBatchLabel" placeholder="Ex: RH-Mars"/></div>
          <div><label><input id="importDryRun" type="checkbox" checked/> Prévalidation uniquement</label></div>
        </div>
        <div class="action-bar mt-3"><button class="btn btn-primary" id="importStartBtn">Démarrer l'import</button></div>
      </div>
      <div class="card">
        <div class="section-header"><h3>Progression live</h3></div>
        <div class="stepper" id="importStepper"></div>
        <div class="progress-track mt-3"><div class="progress-bar" id="importProgressBar"></div></div>
        <p id="simpleRunSummary" class="muted mt-3 text-break">En attente d'exécution.</p>
        <details class="mt-3"><summary>Console technique</summary><pre class="console" id="importConsole"></pre></details>
      </div>
    </div>
    <div class="card"><div class="section-header"><h3>Résultats finaux</h3></div><div id="importSummaryCards" class="grid-kpi"></div><div class="table-wrap mt-3"><table><thead><tr><th>Email</th><th>Statut</th><th>Groupes demandés</th><th>Détails</th></tr></thead><tbody id="importResultsRows"></tbody></table></div></div>`;
  renderStepper('preview');
  $('importStartBtn').addEventListener('click', runImportFlow);
}

function renderStepper(active) {
  $('importStepper').innerHTML = STAGES.map((s) => `<div class="step ${s === active ? 'active' : ''}">${escapeHtml(s)}</div>`).join('');
}
function updateStepper(active) {
  $('importStepper').innerHTML = STAGES.map((s) => {
    const idx = STAGES.indexOf(s);
    const current = STAGES.indexOf(active);
    const cls = idx < current ? 'done' : (idx === current ? 'active' : '');
    return `<div class="step ${cls}">${escapeHtml(s)}</div>`;
  }).join('');
}
function setImportProgress(percent, stage) {
  $('importProgressBar').style.width = `${Math.max(0, Math.min(100, percent || 0))}%`;
  $('simpleRunSummary').textContent = `Étape: ${stage || 'prévalidation'} — ${percent || 0}%`;
}

async function runImportFlow() {
  const f = $('importFile').files?.[0];
  if (!f) return setToast('Sélectionnez un CSV.');
  $('importStartBtn').disabled = true;
  $('importConsole').textContent = '';
  renderStepper('preview');
  setImportProgress(0, 'prévalidation');
  try {
    await apiGet('/api/health');
    const form = new FormData();
    form.append('file', f);
    const res = await fetch('/api/import-stream', { method: 'POST', body: form });
    if (!res.ok || !res.body) throw new Error('Flux import indisponible');
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
        if (['log', 'stderr', 'stdout'].includes(event.type)) $('importConsole').textContent += `${event.type.toUpperCase()} | ${event.message}\n`;
        if (event.type === 'progress') {
          const p = event.payload || {};
          updateStepper(p.stage || 'preview');
          setImportProgress(p.percent || 0, p.stage || 'preview');
        }
        if (event.type === 'final') renderImportFinal(event.payload || {});
      }
    }
    await refreshDashboard();
    await refreshHistory();
    setToast('Import terminé.');
  } catch (e) { setToast(`Erreur import: ${e.message}`); }
  finally { $('importStartBtn').disabled = false; }
}

function renderImportFinal(payload) {
  state.latestImportResults = payload.results || [];
  const s = payload.summary || {};
  const cards = [['Utilisateurs créés', s.users_created || 0], ['Groupes créés', s.groups_created || 0], ['Groupes assignés', s.groups_assigned || 0], ['Erreurs', s.errors || 0], ['Batch', payload.batch_uuid || '-']];
  $('importSummaryCards').innerHTML = cards.map(([l, v]) => `<div class="kpi-card"><p class="muted text-ellipsis">${l}</p><div class="value text-break">${escapeHtml(v)}</div></div>`).join('');
  $('importResultsRows').innerHTML = state.latestImportResults.map((row) => {
    const detail = [row.errors?.length ? `Erreurs: ${row.errors.join(' | ')}` : '', row.groups_created?.length ? `Groupes créés: ${row.groups_created.join(', ')}` : '', row.groups_assigned?.length ? `Groupes assignés: ${row.groups_assigned.join(', ')}` : ''].filter(Boolean).join(' • ') || '-';
    return `<tr><td>${textCell(row.email)}</td><td>${statusBadge(row.user_create_status)}</td><td>${textCell((row.groups_requested || []).join(', '))}</td><td>${textCell(detail)}</td></tr>`;
  }).join('');
}

function renderDeletionsSkeleton() {
  $('deletionsView').innerHTML = `
    ${pageHeader('Suppressions', 'Zone sensible : suppression par batch avec garde-fous visuels.')}
    <div class="card">${statusChip('degraded', 'Action sensible', 'Toujours lancer un dry-run avant suppression réelle')}</div>
    <div class="grid-two">
      <div class="card">
        <div class="section-header"><h3>Préparation</h3></div>
        <p id="deleteConfigStatus" class="muted">Vérification...</p>
        <div class="form-grid"><div><label>Batch cible</label><select id="deleteBatchSelect"></select></div><div><label><input id="deleteDryRunOnly" type="checkbox" checked/> Dry-run uniquement</label></div></div>
        <div class="action-bar mt-3"><button id="deletePreviewBtn" class="btn btn-secondary">Prévisualiser</button></div>
      </div>
      <div class="card danger-zone">
        <div class="section-header"><h3>Danger zone</h3></div>
        <p class="muted line-clamp-2">Cette action est irréversible. Confirmez uniquement après vérification de l'éligibilité.</p>
        <button id="deleteExecuteBtn" class="btn btn-danger" disabled>Supprimer réellement</button>
      </div>
    </div>
    <div class="card"><div class="section-header"><h3>Prévisualisation d’éligibilité</h3></div><div id="deleteEligibility" class="grid-kpi"></div></div>
    <div class="card"><div class="section-header"><h3>Retour d’exécution live</h3></div><div class="table-wrap"><table><thead><tr><th>Email</th><th>Batch</th><th>Statut</th><th>Message</th></tr></thead><tbody id="deleteRows"></tbody></table></div></div>`;
  $('deletePreviewBtn').addEventListener('click', () => runDelete(true));
  $('deleteExecuteBtn').addEventListener('click', () => runDelete(false));
}

async function refreshDeleteConfig() {
  try {
    const [cfg, batches] = await Promise.all([apiGet('/api/delete-config-status'), apiGet('/api/batches')]);
    state.batches = batches?.items || [];
    $('deleteConfigStatus').innerHTML = cfg?.configured ? statusChip('operational', 'Delete API opérationnelle') : statusChip('error', 'Delete API indisponible', cfg?.message || '');
    $('deleteBatchSelect').innerHTML = `<option value="__latest__">Dernier import</option>${state.batches.map((b) => `<option value="${escapeHtml(b.batch_uuid)}">${escapeHtml(b.batch_uuid)} — ${escapeHtml(b.filename || '')}</option>`).join('')}`;
  } catch (e) { $('deleteConfigStatus').textContent = e.message; }
}

async function runDelete(preview) {
  const body = { dry_run_only: preview || $('deleteDryRunOnly').checked };
  const selected = $('deleteBatchSelect').value;
  if (selected && selected !== '__latest__') body.batch_uuid = selected;
  $('deletePreviewBtn').disabled = true;
  $('deleteExecuteBtn').disabled = true;
  try {
    const res = await fetch('/api/delete-users-stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
        if (event.type === 'final') {
          renderDeleteResults(event.payload?.results || []);
          state.deletePreviewDone = true;
          $('deleteExecuteBtn').disabled = false;
          refreshDashboard();
          refreshHistory();
        }
      }
    }
  } catch (e) { setToast(`Erreur suppression: ${e.message}`); }
  finally {
    $('deletePreviewBtn').disabled = false;
    if (!state.deletePreviewDone) $('deleteExecuteBtn').disabled = true;
  }
}

function renderDeleteResults(rows) {
  const counts = {};
  $('deleteRows').innerHTML = rows.map((r) => {
    counts[r.status || 'UNKNOWN'] = (counts[r.status || 'UNKNOWN'] || 0) + 1;
    return `<tr><td>${textCell(r.email)}</td><td>${textCell(r.batch_uuid, 'text-ellipsis')}</td><td>${statusBadge(r.status)}</td><td>${textCell(r.message)}</td></tr>`;
  }).join('');
  $('deleteEligibility').innerHTML = Object.keys(counts).length ? Object.entries(counts).map(([k, v]) => `<div class="kpi-card"><p class="muted text-ellipsis">${escapeHtml(k)}</p><div class="value">${v}</div></div>`).join('') : emptyState('Aucune donnée.');
}

function renderHistorySkeleton() {
  $('historyView').innerHTML = `
    ${pageHeader('Historique', 'Vue master-detail : lots à gauche, détails techniques à droite.')}
    <div class="master-detail">
      <div class="card"><div class="form-grid"><div><label>Recherche</label><input id="historySearch" placeholder="UUID, fichier..." /></div><div><label>Tri</label><select id="historySort"><option value="date_desc">Date ↓</option><option value="date_asc">Date ↑</option><option value="errors_desc">Erreurs ↓</option></select></div></div><div class="batch-list mt-3" id="batchList"></div></div>
      <div class="card" id="historyDetail"></div>
    </div>`;
  $('historySearch').addEventListener('input', () => { state.historySearch = $('historySearch').value.toLowerCase(); renderHistoryList(); });
  $('historySort').addEventListener('change', () => { state.historySort = $('historySort').value; renderHistoryList(); });
}

async function refreshHistory() {
  try {
    const payload = await apiGet('/api/batches');
    state.batches = payload?.items || [];
    if (!state.activeBatch && state.batches[0]) state.activeBatch = state.batches[0].batch_uuid;
    renderHistoryList();
    if (state.activeBatch) loadBatchDetail(state.activeBatch);
  } catch (e) { $('historyDetail').innerHTML = emptyState(e.message); }
}

function renderHistoryList() {
  const filtered = state.batches
    .filter((b) => `${b.batch_uuid} ${b.filename}`.toLowerCase().includes(state.historySearch || ''))
    .sort((a, b) => {
      if (state.historySort === 'date_asc') return new Date(a.created_at) - new Date(b.created_at);
      if (state.historySort === 'errors_desc') return (b.error_count || 0) - (a.error_count || 0);
      return new Date(b.created_at) - new Date(a.created_at);
    });
  $('batchList').innerHTML = filtered.length ? filtered.map((b) => `<div class="batch-item ${b.batch_uuid === state.activeBatch ? 'active' : ''}" data-batch="${escapeHtml(b.batch_uuid)}"><p class="text-ellipsis"><strong>${escapeHtml(b.filename || 'Sans nom')}</strong></p><p class="muted text-ellipsis">${formatDate(b.created_at)}</p><p>${statusBadge(b.status || 'unknown')}</p></div>`).join('') : emptyState('Aucun batch trouvé.');
  document.querySelectorAll('.batch-item').forEach((i) => i.addEventListener('click', () => { state.activeBatch = i.dataset.batch; renderHistoryList(); loadBatchDetail(i.dataset.batch); }));
}

async function loadBatchDetail(uuid) {
  try {
    const payload = await apiGet(`/api/batches/${encodeURIComponent(uuid)}`);
    const users = payload?.users || [];
    const pending = users.filter((u) => u.import_status === 'pending_activation').length;
    const deletable = users.filter((u) => Number(u.deletable_candidate) === 1).length;
    $('historyDetail').innerHTML = `<div class="section-header"><h3>Détail batch</h3></div><div class="grid-kpi"><div class="kpi-card"><p class="muted">batch UUID</p><div class="text-break">${escapeHtml(uuid)}</div></div><div class="kpi-card"><p class="muted">succès</p><div class="value">${users.filter((u) => u.import_status === 'success').length}</div></div><div class="kpi-card"><p class="muted">erreurs</p><div class="value">${users.filter((u) => ['error', 'failed'].includes((u.import_status || '').toLowerCase())).length}</div></div><div class="kpi-card"><p class="muted">pending activation</p><div class="value">${pending}</div></div><div class="kpi-card"><p class="muted">supprimables</p><div class="value">${deletable}</div></div></div><div class="table-wrap mt-3"><table><thead><tr><th>Email</th><th>Rôle</th><th>Statut</th><th>Activation</th><th>Supprimable</th></tr></thead><tbody>${users.map((u) => `<tr><td>${textCell(u.email)}</td><td>${textCell(u.requested_role || '', 'text-ellipsis')}</td><td>${statusBadge(u.import_status)}</td><td>${textCell(u.last_known_activation_state || '-', 'text-ellipsis')}</td><td>${Number(u.deletable_candidate) === 1 ? 'Oui' : 'Non'}</td></tr>`).join('')}</tbody></table></div>`;
  } catch (e) { $('historyDetail').innerHTML = emptyState(e.message); }
}

function renderLogsSkeleton() {
  $('logsAuditView').innerHTML = `
    ${pageHeader('Logs & audit', 'Vue experte : synthèse, flux, tableau détaillé et audit métier.')}
    <div class="card sticky-filters"><div class="form-grid"><div><label>Batch</label><select id="logsBatchFilter"><option value="">Tous</option></select></div><div><label>Scope</label><select id="logsScopeFilter"><option value="">Tous</option><option value="import">Import</option><option value="delete">Delete</option><option value="system">System</option></select></div><div><label>Niveau</label><select id="logsLevelFilter"><option value="">Tous</option><option value="info">Info</option><option value="warning">Warning</option><option value="error">Error</option><option value="audit">Audit</option></select></div><div><label>Recherche texte</label><input id="logsTextSearch" placeholder="email, message, path..." /></div></div><div class="action-bar mt-3"><button id="logsRefreshBtn" class="btn btn-secondary">Rafraîchir</button><button id="logsExportBtn" class="btn btn-secondary">Export CSV</button><button id="logsDeleteBatchBtn" class="btn btn-secondary">Supprimer logs batch</button><button id="logsDeleteAllBtn" class="btn btn-danger">Supprimer tous les logs</button></div></div>
    <div class="card"><div class="tabs"><button class="btn btn-secondary tab-btn active" data-tab="summaryTab">Synthèse</button><button class="btn btn-secondary tab-btn" data-tab="streamTab">Flux</button><button class="btn btn-secondary tab-btn" data-tab="tableTab">Tableau</button><button class="btn btn-secondary tab-btn" data-tab="auditTab">Audit métier</button></div><div id="summaryTab" class="tab-panel active"></div><div id="streamTab" class="tab-panel"><pre id="logsStream" class="console"></pre></div><div id="tableTab" class="tab-panel"><div class="table-wrap"><table><thead><tr><th>Date</th><th>Scope</th><th>Niveau</th><th>Batch</th><th>Email</th><th>Message</th></tr></thead><tbody id="logsRows"></tbody></table></div></div><div id="auditTab" class="tab-panel"></div></div>`;

  document.querySelectorAll('.tab-btn').forEach((b) => b.addEventListener('click', () => {
    state.logsTab = b.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach((x) => x.classList.toggle('active', x.dataset.tab === state.logsTab));
    document.querySelectorAll('.tab-panel').forEach((x) => x.classList.toggle('active', x.id === state.logsTab));
  }));
  $('logsRefreshBtn').addEventListener('click', refreshLogs);
  $('logsExportBtn').addEventListener('click', () => { window.location.href = `/api/logs/export.csv?${new URLSearchParams(currentLogsFilters()).toString()}`; });
  $('logsDeleteBatchBtn').addEventListener('click', () => deleteLogs(true));
  $('logsDeleteAllBtn').addEventListener('click', () => deleteLogs(false));
  ['logsBatchFilter', 'logsScopeFilter', 'logsLevelFilter', 'logsTextSearch'].forEach((id) => $(id).addEventListener('change', refreshLogs));
}

function currentLogsFilters() {
  const f = {};
  if ($('logsBatchFilter')?.value) f.batch_uuid = $('logsBatchFilter').value;
  if ($('logsScopeFilter')?.value) f.scope = $('logsScopeFilter').value;
  if ($('logsLevelFilter')?.value) f.level = $('logsLevelFilter').value;
  return f;
}

async function refreshLogs() {
  try {
    const query = new URLSearchParams(currentLogsFilters()).toString();
    const [logs, summary, batches] = await Promise.all([apiGet(`/api/logs${query ? `?${query}` : ''}`), apiGet(`/api/logs/summary${query ? `?${query}` : ''}`), apiGet('/api/batches').catch(() => ({ items: [] }))]);
    const currentBatch = $('logsBatchFilter').value;
    $('logsBatchFilter').innerHTML = `<option value="">Tous</option>${(batches.items || []).map((b) => `<option value="${escapeHtml(b.batch_uuid)}">${escapeHtml(b.batch_uuid)}</option>`).join('')}`;
    if (currentBatch) $('logsBatchFilter').value = currentBatch;

    $('summaryTab').innerHTML = `<div class="grid-kpi"><div class="kpi-card"><p class="muted">Total logs</p><div class="value">${summary.total_logs || 0}</div></div><div class="kpi-card"><p class="muted">Erreurs</p><div class="value">${summary.by_level?.error || 0}</div></div><div class="kpi-card"><p class="muted">Warnings</p><div class="value">${summary.by_level?.warning || 0}</div></div><div class="kpi-card"><p class="muted">Dernier log</p><div class="line-clamp-2 text-break">${escapeHtml(summary.last_log?.message || 'Aucun')}</div></div></div>`;

    const rows = logs.items || [];
    const textFilter = ($('logsTextSearch').value || '').toLowerCase();
    const filtered = rows.filter((r) => `${r.message || ''} ${r.email || ''} ${r.batch_uuid || ''}`.toLowerCase().includes(textFilter));
    $('logsRows').innerHTML = filtered.map((r) => `<tr><td>${textCell(formatDate(r.created_at), 'text-ellipsis')}</td><td>${textCell(r.scope || '', 'text-ellipsis')}</td><td>${statusBadge(r.level)}</td><td>${textCell(r.batch_uuid || '')}</td><td>${textCell(r.email || '')}</td><td>${textCell(r.message || '')}</td></tr>`).join('');
    $('logsStream').textContent = filtered.map((r) => `[${formatDate(r.created_at)}] [${(r.level || 'info').toUpperCase()}] ${r.message}`).join('\n');
    $('auditTab').innerHTML = filtered.filter((r) => (r.level || '').toLowerCase() === 'audit').map((a) => `<div class="audit-line"><span class="muted text-ellipsis">${formatDate(a.created_at)}</span><div class="text-break">${escapeHtml(a.message || '')}</div></div>`).join('') || emptyState('Aucun événement métier.');
  } catch (e) { setToast(`Logs indisponibles: ${e.message}`); }
}

async function deleteLogs(byBatch = false) {
  try {
    let url = '/api/logs';
    if (byBatch) {
      const batch = $('logsBatchFilter').value;
      if (!batch) return setToast('Sélectionnez un batch.');
      url += `?batch_uuid=${encodeURIComponent(batch)}`;
    }
    await apiDelete(url);
    refreshLogs();
    setToast('Suppression effectuée.');
  } catch (e) { setToast(e.message); }
}

function renderLayout() {
  renderDashboardSkeleton();
  renderImporterSkeleton();
  renderDeletionsSkeleton();
  renderHistorySkeleton();
  renderLogsSkeleton();
}

function init() {
  renderLayout();
  document.querySelectorAll('.menu-item').forEach((item) => item.addEventListener('click', (e) => { e.preventDefault(); switchView(item.dataset.view); }));
  refreshDashboard();
  refreshDeleteConfig();
  refreshHistory();
  refreshLogs();
}

init();
