import { apiDelete, apiGet } from '../api.js';
import { state } from '../state.js';
import { $, escapeHtml, formatDate, setToast } from '../utils.js';
import { emptyState } from '../components/empty-state.js';
import { kpiCard } from '../components/kpi-card.js';
import { logRow } from '../components/logs-table.js';

export function renderLogsView() {
  $('logsAuditView').innerHTML = `<div class="card sticky-filters"><div class="form-grid"><div><label>Batch</label><select id="logsBatchFilter"><option value="">Tous</option></select></div><div><label>Scope</label><select id="logsScopeFilter"><option value="">Tous</option><option value="import">Import</option><option value="delete">Delete</option><option value="system">System</option></select></div><div><label>Niveau</label><select id="logsLevelFilter"><option value="">Tous</option><option value="info">Info</option><option value="warning">Warning</option><option value="error">Error</option><option value="audit">Audit</option></select></div><div><label>Recherche texte</label><input id="logsTextSearch" placeholder="email, message, path..." /></div></div><div class="action-bar mt-3"><button id="logsRefreshBtn" class="btn btn-secondary">Rafraîchir</button><button id="logsExportBtn" class="btn btn-secondary">Export CSV</button><button id="logsDeleteBatchBtn" class="btn btn-secondary">Supprimer logs batch</button><button id="logsDeleteAllBtn" class="btn btn-danger">Supprimer tous les logs</button></div></div><div class="card"><div class="tabs"><button class="btn btn-secondary tab-btn active" data-tab="summaryTab">Synthèse</button><button class="btn btn-secondary tab-btn" data-tab="streamTab">Flux</button><button class="btn btn-secondary tab-btn" data-tab="tableTab">Tableau</button><button class="btn btn-secondary tab-btn" data-tab="auditTab">Audit métier</button></div><div id="summaryTab" class="tab-panel active logs-summary"></div><div id="streamTab" class="tab-panel"><pre id="logsStream" class="console logs-stream-console"></pre></div><div id="tableTab" class="tab-panel"><div class="table-wrap"><table class="logs-table"><thead><tr><th>Date</th><th>Scope</th><th>Niveau</th><th>Batch</th><th>Email</th><th>Message</th></tr></thead><tbody id="logsRows"></tbody></table></div></div><div id="auditTab" class="tab-panel"></div></div>`;

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

export async function refreshLogs() {
  try {
    const query = new URLSearchParams(currentLogsFilters()).toString();
    const [logs, summary, batches] = await Promise.all([apiGet(`/api/logs${query ? `?${query}` : ''}`), apiGet(`/api/logs/summary${query ? `?${query}` : ''}`), apiGet('/api/batches').catch(() => ({ items: [] }))]);
    const currentBatch = $('logsBatchFilter')?.value;
    if ($('logsBatchFilter')) {
      $('logsBatchFilter').innerHTML = `<option value="">Tous</option>${(batches.items || []).map((b) => `<option value="${escapeHtml(b.batch_uuid)}">${escapeHtml(b.batch_uuid)}</option>`).join('')}`;
      if (currentBatch) $('logsBatchFilter').value = currentBatch;
    }

    $('summaryTab').innerHTML = `<div class="grid-kpi compact-kpi">${kpiCard('Total logs', summary.total_logs || 0)}${kpiCard('Erreurs', summary.by_level?.error || 0)}${kpiCard('Warnings', summary.by_level?.warning || 0)}${kpiCard('Dernier log', summary.last_log?.message || 'Aucun')}</div>`;
    const rows = logs.items || [];
    const textFilter = ($('logsTextSearch')?.value || '').toLowerCase();
    const filtered = rows.filter((r) => `${r.message || ''} ${r.email || ''} ${r.batch_uuid || ''}`.toLowerCase().includes(textFilter));
    $('logsRows').innerHTML = filtered.map(logRow).join('');
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
