import { apiDelete, apiGet } from '../api.js';
import { state } from '../state.js';
import { $, escapeHtml, formatDate, setToast } from '../utils.js';
import { emptyState } from '../components/empty-state.js';
import { kpiCard } from '../components/kpi-card.js';
import { logRow } from '../components/logs-table.js';

export function renderLogsView() {
  $('logsAuditView').innerHTML = `<div class="card sticky-filters logs-filters-card"><div class="form-grid"><div><label>Batch</label><select id="logsBatchFilter"><option value="">Tous</option></select></div><div><label>Scope</label><select id="logsScopeFilter"><option value="">Tous</option><option value="import">Import</option><option value="delete">Delete</option><option value="system">System</option><option value="groups">Groups</option></select></div><div><label>Niveau</label><select id="logsLevelFilter"><option value="">Tous</option><option value="info">Info</option><option value="warning">Warning</option><option value="error">Error</option><option value="audit">Audit</option></select></div><div><label>Recherche texte</label><input id="logsTextSearch" placeholder="email, message, path..." /></div></div><div class="action-bar mt-3"><button id="logsRefreshBtn" class="btn btn-secondary">Rafraîchir</button><button id="logsExportBtn" class="btn btn-secondary">Export CSV</button><button id="logsDeleteBatchBtn" class="btn btn-secondary">Supprimer logs batch</button><button id="logsDeleteAllBtn" class="btn btn-danger">Supprimer tous les logs</button></div></div><div class="card logs-audit-card"><div class="logs-section-header"><h3>Logs & audit</h3><p class="muted">Synthèse, flux technique temps réel et événements métier.</p></div><div class="tabs"><button class="btn btn-secondary tab-btn active" data-tab="summaryTab">Synthèse</button><button class="btn btn-secondary tab-btn" data-tab="streamTab">Flux temps réel</button><button class="btn btn-secondary tab-btn" data-tab="tableTab">Tableau détaillé</button><button class="btn btn-secondary tab-btn" data-tab="auditTab">Audit métier</button></div><div id="summaryTab" class="tab-panel active logs-summary"></div><div id="streamTab" class="tab-panel"><div id="logsStreamWrap" class="logs-stream-box"><pre id="logsStream" class="console logs-stream-console"></pre></div></div><div id="tableTab" class="tab-panel"><div class="table-wrap"><table class="logs-table"><thead><tr><th>Date</th><th>Scope</th><th>Niveau</th><th>Batch</th><th>Email</th><th>Message</th></tr></thead><tbody id="logsRows"></tbody></table></div><div id="logsTableState" class="mt-3"></div></div><div id="auditTab" class="tab-panel"></div></div>`;

  document.querySelectorAll('.tab-btn').forEach((b) => b.addEventListener('click', () => {
    state.logsTab = b.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach((x) => x.classList.toggle('active', x.dataset.tab === state.logsTab));
    document.querySelectorAll('.tab-panel').forEach((x) => x.classList.toggle('active', x.id === state.logsTab));
  }));

  $('logsRefreshBtn').addEventListener('click', refreshLogs);
  $('logsExportBtn').addEventListener('click', () => { window.location.href = `/api/logs/export.csv?${new URLSearchParams(currentLogsFilters()).toString()}`; });
  $('logsDeleteBatchBtn').addEventListener('click', () => deleteLogs(true));
  $('logsDeleteAllBtn').addEventListener('click', () => deleteLogs(false));
  ['logsBatchFilter', 'logsScopeFilter', 'logsLevelFilter'].forEach((id) => $(id).addEventListener('change', refreshLogs));
  $('logsTextSearch').addEventListener('input', applyLogsTextFilter);
}

function currentLogsFilters() {
  const f = {};
  if ($('logsBatchFilter')?.value) f.batch_uuid = $('logsBatchFilter').value;
  if ($('logsScopeFilter')?.value) f.scope = $('logsScopeFilter').value;
  if ($('logsLevelFilter')?.value) f.level = $('logsLevelFilter').value;
  return f;
}

function updateFiltersBatches(batches = []) {
  const currentBatch = $('logsBatchFilter')?.value;
  if (!$('logsBatchFilter')) return;
  $('logsBatchFilter').innerHTML = `<option value="">Tous</option>${(batches || []).map((b) => `<option value="${escapeHtml(b.batch_uuid)}">${escapeHtml(b.batch_uuid)}</option>`).join('')}`;
  if (currentBatch) $('logsBatchFilter').value = currentBatch;
}

function renderSummary(summary = {}, rows = []) {
  $('summaryTab').innerHTML = `<div class="grid-kpi compact-kpi">${kpiCard('Total logs', summary.total_logs || 0)}${kpiCard('Erreurs', summary.by_level?.error || 0)}${kpiCard('Warnings', summary.by_level?.warning || 0)}${kpiCard('Audit', summary.by_level?.audit || 0)}${kpiCard('Dernier log', summary.last_log?.message || 'Aucun')}</div>${rows.length ? '' : `<div class="mt-3">${emptyState('Aucun log disponible pour les filtres actuels.')}</div>`}`;
}

function renderStream(rows = [], errorMessage = '') {
  const stream = $('logsStream');
  const streamWrap = $('logsStreamWrap');
  if (!stream || !streamWrap) return;

  streamWrap.classList.toggle('is-error', Boolean(errorMessage));
  if (errorMessage) {
    stream.textContent = `Flux indisponible\n${errorMessage}`;
    return;
  }
  if (!rows.length) {
    stream.textContent = 'Aucun événement dans le flux pour le moment.';
    return;
  }
  stream.textContent = rows.map((r) => `[${formatDate(r.created_at)}] [${(r.level || 'info').toUpperCase()}] [${(r.scope || 'system').toUpperCase()}] ${r.message || ''}`).join('\n');
}

function renderTable(rows = []) {
  $('logsRows').innerHTML = rows.map(logRow).join('');
  $('logsTableState').innerHTML = rows.length ? '' : emptyState('Aucune ligne à afficher dans le tableau détaillé.');
}

function renderAudit(rows = []) {
  const auditRows = rows.filter((r) => (r.level || '').toLowerCase() === 'audit');
  $('auditTab').innerHTML = auditRows.map((a) => `<div class="audit-line"><span class="muted text-ellipsis">${formatDate(a.created_at)}</span><div class="text-break">${escapeHtml(a.message || '')}</div></div>`).join('') || emptyState('Aucun événement métier.');
}

function applyLogsTextFilter() {
  const textFilter = ($('logsTextSearch')?.value || '').toLowerCase();
  const rows = state.logsRowsRaw || [];
  const filtered = rows.filter((r) => `${r.message || ''} ${r.email || ''} ${r.batch_uuid || ''} ${r.scope || ''} ${r.level || ''}`.toLowerCase().includes(textFilter));
  renderStream(filtered);
  renderTable(filtered);
  renderAudit(filtered);
}

export async function refreshLogs() {
  $('summaryTab').innerHTML = '<p class="muted">Chargement de la synthèse…</p>';
  $('logsRows').innerHTML = '';
  $('logsTableState').innerHTML = '<p class="muted">Chargement du tableau…</p>';
  renderStream([], 'Chargement du flux…');
  $('auditTab').innerHTML = '<p class="muted">Chargement de l\'audit…</p>';

  const query = new URLSearchParams(currentLogsFilters()).toString();
  const logsPath = `/api/logs${query ? `?${query}` : ''}`;
  const summaryPath = `/api/logs/summary${query ? `?${query}` : ''}`;

  const [logsResult, summaryResult, batchesResult] = await Promise.allSettled([
    apiGet(logsPath),
    apiGet(summaryPath),
    apiGet('/api/batches')
  ]);

  const logsError = logsResult.status === 'rejected' ? logsResult.reason?.message || 'Erreur inconnue' : '';
  const summaryError = summaryResult.status === 'rejected' ? summaryResult.reason?.message || 'Erreur inconnue' : '';
  const batches = batchesResult.status === 'fulfilled' ? batchesResult.value : { items: [] };
  updateFiltersBatches(batches.items || []);

  const logsPayload = logsResult.status === 'fulfilled' ? logsResult.value : { items: [] };
  const summaryPayload = summaryResult.status === 'fulfilled' ? summaryResult.value : { total_logs: 0, by_level: {}, by_scope: {}, last_log: null };

  state.logsRowsRaw = logsPayload.items || [];

  if (summaryError) {
    $('summaryTab').innerHTML = emptyState(`Synthèse indisponible: ${summaryError}`);
  } else {
    renderSummary(summaryPayload, state.logsRowsRaw);
  }

  if (logsError) {
    $('logsRows').innerHTML = '';
    $('logsTableState').innerHTML = emptyState(`Tableau indisponible: ${logsError}`);
    $('auditTab').innerHTML = emptyState(`Audit indisponible: ${logsError}`);
    renderStream([], logsError);
    setToast(`Logs indisponibles: ${logsError}`);
    return;
  }

  applyLogsTextFilter();
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
