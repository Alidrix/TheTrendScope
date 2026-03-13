const state = {
  view: 'dashboardView',
  activeBatch: null,
  batches: [],
  latestImportResults: [],
  deletePreviewDone: false,
  logsTab: 'summaryTab',
  historySearch: '',
  historySort: 'date_desc'
};

const STAGES = ['preview', 'create-user', 'create-group', 'assign-group', 'done'];

function $(id) { return document.getElementById(id); }
function escapeHtml(v) { return (v || '').toString().replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])); }
function formatDate(v) { if (!v) return '-'; const d = new Date(v); return Number.isNaN(d.getTime()) ? v : d.toLocaleString(); }
function setToast(msg) { const t = $('toast'); t.textContent = msg; t.style.display = 'block'; setTimeout(() => (t.style.display = 'none'), 2800); }

function statusChip(kind = 'unknown', text = 'Inconnu') {
  const map = { ok: 'status-ok', info: 'status-info', warn: 'status-warn', error: 'status-error', unknown: 'status-unknown' };
  return `<span class="status-chip ${map[kind] || map.unknown}"><i></i>${escapeHtml(text)}</span>`;
}

function statusBadge(status) {
  const s = (status || '').toLowerCase();
  if (['success', 'completed', 'created', 'pending_activation', 'deleted'].includes(s)) return statusChip('ok', status || 'succès');
  if (['warning', 'partial', 'deferred', 'skipped_active_user'].includes(s)) return statusChip('warn', status || 'attention');
  if (['error', 'failed', 'blocked_by_passbolt'].includes(s)) return statusChip('error', status || 'erreur');
  if (['info', 'skipped', 'rollback_required_manual'].includes(s)) return statusChip('info', status || 'info');
  return statusChip('unknown', status || 'inconnu');
}

async function apiGet(path) {
  const res = await fetch(path);
  const txt = await res.text();
  let payload = {};
  try { payload = txt ? JSON.parse(txt) : {}; } catch { throw new Error(`Réponse invalide (${path})`); }
  if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
  return payload;
}

function pageHeader(title, subtitle, actions = '') {
  return `<div class="card page-header"><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(subtitle)}</p></div><div class="action-bar">${actions}</div></div>`;
}

function renderLayout() {
  renderDashboardSkeleton();
  renderImporterSkeleton();
  renderDeletionsSkeleton();
  renderHistorySkeleton();
  renderLogsSkeleton();
}

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
    ${pageHeader('Dashboard', 'Supervision globale des imports et de la santé système', '<button id="dashboardRefresh" class="btn btn-secondary">Rafraîchir</button>')}
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
      { label: 'API Import', ok: Boolean(health?.ok), detail: health?.resolved_container || 'N/A' },
      { label: 'Delete API', ok: Boolean(deleteCfg?.configured), detail: deleteCfg?.message || 'Configuration' },
      { label: 'Base locale', ok: true, detail: `${dbSummary?.batches_count || 0} batch(es)` },
      { label: 'Passbolt / CLI', ok: Boolean(health?.resolved_cli_path), detail: health?.resolved_cli_path || 'Inconnu' }
    ];

    $('healthGrid').innerHTML = healthCards.map((h) => `
      <div class="health-card"><div class="label">${h.label}</div><div>${h.ok ? statusChip('ok', 'Opérationnel') : statusChip('warn', 'À vérifier')}</div><div class="muted">${escapeHtml(h.detail)}</div></div>
    `).join('');

    const kpis = [
      ['Imports aujourd’hui', state.batches.filter((b) => new Date(b.created_at).toDateString() === new Date().toDateString()).length],
      ['Utilisateurs créés', latest?.success_count || 0],
      ['Groupes assignés', latest?.group_assignments || 0],
      ['Erreurs 24h', logsSummary?.by_level?.error || 0],
      ['Batches enregistrés', dbSummary?.batches_count || 0],
      ['Candidats supprimables', dbSummary?.deletable_candidates_count || 0]
    ];
    $('kpiGrid').innerHTML = kpis.map(([label, value]) => `<div class="kpi-card"><div class="label">${label}</div><div class="value">${value}</div></div>`).join('');

    $('lastImportBlock').innerHTML = latest
      ? `<p><strong>${escapeHtml(latest.filename || '-')}</strong></p><p class="muted">${formatDate(latest.created_at)}</p><p>${statusBadge(latest.status || 'unknown')}</p>`
      : '<div class="empty-state">Aucun import enregistré.</div>';

    const alerts = Object.entries(logsSummary?.by_level || {}).filter(([k]) => ['error', 'warning'].includes(k));
    $('alertsBlock').innerHTML = alerts.length
      ? alerts.map(([level, count]) => `<p>${statusBadge(level)} <strong>${count}</strong> sur 24h</p>`).join('')
      : '<div class="empty-state">Aucune alerte récente.</div>';

    $('activityBlock').innerHTML = (state.batches.slice(0, 4).map((b) => `<p>${formatDate(b.created_at)}<br><strong>${escapeHtml(b.filename)}</strong> — ${statusBadge(b.status || '')}</p>`).join('')) || '<div class="empty-state">Pas d’activité.</div>';

    $('systemPulse').innerHTML = `
      ${statusChip(health?.ok ? 'ok' : 'warn', `API import ${health?.ok ? 'OK' : 'KO'}`)}
      ${statusChip(deleteCfg?.configured ? 'ok' : 'error', `Delete API ${deleteCfg?.configured ? 'prête' : 'non prête'}`)}
    `;
  } catch (e) { setToast(`Dashboard indisponible: ${e.message}`); }
}

function renderImporterSkeleton() {
  $('importerView').innerHTML = `
    ${pageHeader('Importer', 'Workflow guidé d’import CSV avec prévalidation et suivi live')}
    <div class="grid-two">
      <div class="card">
        <div class="section-header"><h3>1. Dépôt CSV</h3></div>
        <div class="drop-zone">
          <p><strong>Déposez votre CSV</strong></p>
          <p class="muted">Format attendu : email,firstname,lastname,role[,groups]</p>
          <input type="file" id="importFile" accept=".csv" />
        </div>
        <div id="readinessBanner"></div>
      </div>
      <div class="card">
        <div class="section-header"><h3>ProgressStepper</h3></div>
        <div class="stepper" id="stepper"></div>
        <div class="progress-track"><div class="progress-bar" id="importProgress"></div></div>
        <p id="importProgressText" class="muted">0% — Prévalidation</p>
      </div>
    </div>
    <div class="grid-two">
      <div class="card"><div class="section-header"><h3>2. Prévalidation</h3></div><div id="prevalidationBlock" class="muted">Aucun fichier analysé.</div></div>
      <div class="card">
        <div class="section-header"><h3>3. Options d’exécution</h3></div>
        <label><input id="rollbackOnError" type="checkbox" /> Rollback si erreur</label>
        <div class="action-bar" style="margin-top:12px">
          <button id="importStartBtn" class="btn btn-primary">Lancer l’import</button>
        </div>
        <div id="simpleRunSummary" class="muted" style="margin-top:8px">En attente d’exécution.</div>
      </div>
    </div>
    <div class="card console-panel">
      <details><summary>Voir la console technique</summary><pre id="importConsole" class="console"></pre></details>
    </div>
    <div class="card">
      <div class="section-header"><h3>4. Résultats finaux</h3></div>
      <div id="importSummaryCards" class="grid-kpi"></div>
      <div class="table-wrap"><table><thead><tr><th>Email</th><th>Statut</th><th>Groupes demandés</th><th>Détails</th></tr></thead><tbody id="importResultsRows"></tbody></table></div>
    </div>`;

  updateStepper('preview');
  $('importFile').addEventListener('change', (e) => analyzeCsvFile(e.target.files?.[0]));
  $('importStartBtn').addEventListener('click', runImportWorkflow);
}

function updateStepper(stage) {
  $('stepper').innerHTML = STAGES.map((s) => {
    const done = STAGES.indexOf(s) < STAGES.indexOf(stage);
    const active = s === stage;
    return `<div class="step ${done ? 'done' : ''} ${active ? 'active' : ''}">${s === 'done' ? 'Terminé' : s.replace('-', ' ')}</div>`;
  }).join('');
}

function setImportProgress(percent, stage) {
  $('importProgress').style.width = `${Math.max(0, Math.min(100, percent))}%`;
  $('importProgressText').textContent = `${Math.round(percent)}% — ${stage}`;
}

async function analyzeCsvFile(file) {
  if (!file) return;
  const text = await file.text();
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = (lines[0] || '').split(',').map((h) => h.trim().toLowerCase());
  const expected = ['email', 'firstname', 'lastname', 'role'];
  const missing = expected.filter((c) => !header.includes(c));
  const roleIndex = header.indexOf('role');
  const groupsIndex = header.indexOf('groups');
  const rows = lines.slice(1).map((l) => l.split(','));
  const roles = new Set();
  const groups = new Set();
  let anomalies = 0;

  rows.forEach((r) => {
    if (roleIndex >= 0) roles.add((r[roleIndex] || '').trim().toLowerCase());
    if (groupsIndex >= 0) (r[groupsIndex] || '').split(';').map((g) => g.trim()).filter(Boolean).forEach((g) => groups.add(g));
    if (!r[0] || !r[0].includes('@')) anomalies += 1;
  });

  $('prevalidationBlock').innerHTML = `
    <p>Colonnes détectées : <strong>${escapeHtml(header.join(', ') || 'aucune')}</strong></p>
    <p>Rôles détectés : <strong>${escapeHtml(Array.from(roles).filter(Boolean).join(', ') || 'aucun')}</strong></p>
    <p>Groupes détectés : <strong>${escapeHtml(Array.from(groups).join(', ') || 'aucun')}</strong></p>
    <p>Anomalies détectées : <strong>${anomalies}</strong></p>`;

  const ready = missing.length === 0 && lines.length > 1;
  const banner = missing.length ? statusChip('error', `Import bloqué — colonnes manquantes: ${missing.join(', ')}`)
    : anomalies ? statusChip('warn', 'Import possible avec avertissements')
      : statusChip('ok', 'Prêt à importer');
  $('readinessBanner').innerHTML = `<div style="margin-top:10px">${banner}</div>`;
}

async function runImportWorkflow() {
  const file = $('importFile').files?.[0];
  if (!file) return setToast('Sélectionnez un fichier CSV.');
  $('importStartBtn').disabled = true;
  $('importConsole').textContent = '';
  $('importResultsRows').innerHTML = '';
  $('importSummaryCards').innerHTML = '';
  setImportProgress(5, 'Prévalidation');

  const form = new FormData();
  form.append('file', file);
  form.append('rollback_on_error', String($('rollbackOnError').checked));

  try {
    const response = await fetch('/api/import-stream', { method: 'POST', body: form });
    if (!response.ok || !response.body) throw new Error('Flux import indisponible');
    const reader = response.body.getReader();
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
        if (event.type === 'log' || event.type === 'stderr' || event.type === 'stdout') $('importConsole').textContent += `${event.type.toUpperCase()} | ${event.message}\n`;
        if (event.type === 'progress') {
          const p = event.payload || {};
          updateStepper(p.stage || 'preview');
          setImportProgress(p.percent || 0, p.stage || 'Prévalidation');
          $('simpleRunSummary').textContent = `Étape: ${p.stage || 'preview'} — ${p.percent || 0}%`;
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
  const cards = [
    ['Utilisateurs créés', s.users_created || 0],
    ['Groupes créés', s.groups_created || 0],
    ['Groupes assignés', s.groups_assigned || 0],
    ['Erreurs', s.errors || 0],
    ['Batch', payload.batch_uuid || '-']
  ];
  $('importSummaryCards').innerHTML = cards.map(([l, v]) => `<div class="kpi-card"><div class="label">${l}</div><div class="value">${escapeHtml(v)}</div></div>`).join('');

  $('importResultsRows').innerHTML = state.latestImportResults.map((row) => {
    const detail = [
      row.errors?.length ? `Erreurs: ${row.errors.join(' | ')}` : '',
      row.groups_created?.length ? `Groupes créés: ${row.groups_created.join(', ')}` : '',
      row.groups_assigned?.length ? `Groupes assignés: ${row.groups_assigned.join(', ')}` : ''
    ].filter(Boolean).join(' • ') || '-';
    return `<tr><td>${escapeHtml(row.email)}</td><td>${statusBadge(row.user_create_status)}</td><td>${escapeHtml((row.groups_requested || []).join(', '))}</td><td>${escapeHtml(detail)}</td></tr>`;
  }).join('');
}

function renderDeletionsSkeleton() {
  $('deletionsView').innerHTML = `
    ${pageHeader('Suppressions', 'Gestion prudente des suppressions utilisateurs par batch')}
    <div class="card">${statusChip('warn', 'Action sensible : exécuter un dry-run avant toute suppression réelle.')}</div>
    <div class="grid-two">
      <div class="card">
        <div class="section-header"><h3>Configuration Delete API</h3></div>
        <p id="deleteConfigStatus" class="muted">Vérification en cours...</p>
        <div class="form-grid">
          <div><label>Batch cible</label><select id="deleteBatchSelect"></select></div>
          <div><label><input type="checkbox" id="deleteDryRunOnly" checked /> Dry-run uniquement</label></div>
        </div>
        <div class="action-bar" style="margin-top:10px">
          <button id="deletePreviewBtn" class="btn btn-secondary">Prévisualiser</button>
        </div>
      </div>
      <div class="card danger-zone">
        <div class="section-header"><h3>DangerZone</h3></div>
        <p class="muted">La suppression réelle est activée uniquement après un dry-run concluant.</p>
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
    $('deleteConfigStatus').innerHTML = cfg?.configured ? statusChip('ok', 'Delete API prête') : statusChip('error', `Delete API non prête: ${cfg?.message || ''}`);
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
    return `<tr><td>${escapeHtml(r.email)}</td><td>${escapeHtml(r.batch_uuid)}</td><td>${statusBadge(r.status)}</td><td>${escapeHtml(r.message || '')}</td></tr>`;
  }).join('');
  $('deleteEligibility').innerHTML = Object.keys(counts).length
    ? Object.entries(counts).map(([k, v]) => `<div class="kpi-card"><div class="label">${escapeHtml(k)}</div><div class="value">${v}</div></div>`).join('')
    : '<div class="empty-state">Aucune donnée.</div>';
}

function renderHistorySkeleton() {
  $('historyView').innerHTML = `
    ${pageHeader('Historique', 'Vue master-detail des batches et utilisateurs importés')}
    <div class="master-detail">
      <div class="card">
        <div class="form-grid">
          <div><label>Recherche</label><input id="historySearch" placeholder="UUID, fichier..." /></div>
          <div><label>Tri</label><select id="historySort"><option value="date_desc">Date ↓</option><option value="date_asc">Date ↑</option><option value="errors_desc">Erreurs ↓</option></select></div>
        </div>
        <div class="batch-list" id="batchList"></div>
      </div>
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
  } catch (e) { $('historyDetail').innerHTML = `<div class="empty-state">${escapeHtml(e.message)}</div>`; }
}

function renderHistoryList() {
  const filtered = state.batches
    .filter((b) => `${b.batch_uuid} ${b.filename}`.toLowerCase().includes(state.historySearch || ''))
    .sort((a, b) => {
      if (state.historySort === 'date_asc') return new Date(a.created_at) - new Date(b.created_at);
      if (state.historySort === 'errors_desc') return (b.error_count || 0) - (a.error_count || 0);
      return new Date(b.created_at) - new Date(a.created_at);
    });

  $('batchList').innerHTML = filtered.length ? filtered.map((b) => `
    <div class="batch-item ${b.batch_uuid === state.activeBatch ? 'active' : ''}" data-batch="${escapeHtml(b.batch_uuid)}">
      <strong>${escapeHtml(b.filename || 'Sans nom')}</strong>
      <p class="muted">${formatDate(b.created_at)}</p>
      <p>${statusBadge(b.status || 'unknown')}</p>
    </div>`).join('') : '<div class="empty-state">Aucun batch trouvé.</div>';

  document.querySelectorAll('.batch-item').forEach((i) => i.addEventListener('click', () => { state.activeBatch = i.dataset.batch; renderHistoryList(); loadBatchDetail(i.dataset.batch); }));
}

async function loadBatchDetail(uuid) {
  try {
    const payload = await apiGet(`/api/batches/${encodeURIComponent(uuid)}`);
    const users = payload?.users || [];
    const pending = users.filter((u) => u.import_status === 'pending_activation').length;
    const deletable = users.filter((u) => Number(u.deletable_candidate) === 1).length;
    $('historyDetail').innerHTML = `
      <div class="section-header"><h3>Détail batch</h3></div>
      <div class="grid-kpi">
        <div class="kpi-card"><div class="label">batch UUID</div><div>${escapeHtml(uuid)}</div></div>
        <div class="kpi-card"><div class="label">succès</div><div class="value">${users.filter((u) => u.import_status === 'success').length}</div></div>
        <div class="kpi-card"><div class="label">erreurs</div><div class="value">${users.filter((u) => ['error', 'failed'].includes((u.import_status || '').toLowerCase())).length}</div></div>
        <div class="kpi-card"><div class="label">pending activation</div><div class="value">${pending}</div></div>
        <div class="kpi-card"><div class="label">supprimables</div><div class="value">${deletable}</div></div>
      </div>
      <div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>Email</th><th>Rôle</th><th>Statut</th><th>Activation</th><th>Supprimable</th></tr></thead>
      <tbody>${users.map((u) => `<tr><td>${escapeHtml(u.email)}</td><td>${escapeHtml(u.requested_role || '')}</td><td>${statusBadge(u.import_status)}</td><td>${escapeHtml(u.last_known_activation_state || '-')}</td><td>${Number(u.deletable_candidate) === 1 ? 'Oui' : 'Non'}</td></tr>`).join('')}</tbody></table></div>`;
  } catch (e) { $('historyDetail').innerHTML = `<div class="empty-state">${escapeHtml(e.message)}</div>`; }
}

function renderLogsSkeleton() {
  $('logsAuditView').innerHTML = `
    ${pageHeader('Logs & audit', 'Vue experte séparée : synthèse, flux, tableau, audit métier')}
    <div class="card">
      <div class="form-grid" id="logsFilters">
        <div><label>Batch</label><select id="logsBatchFilter"><option value="">Tous</option></select></div>
        <div><label>Scope</label><select id="logsScopeFilter"><option value="">Tous</option><option value="import">Import</option><option value="delete">Delete</option><option value="system">System</option></select></div>
        <div><label>Niveau</label><select id="logsLevelFilter"><option value="">Tous</option><option value="info">Info</option><option value="warning">Warning</option><option value="error">Error</option><option value="audit">Audit</option></select></div>
        <div><label>Recherche texte</label><input id="logsTextSearch" placeholder="email, message..." /></div>
      </div>
      <div class="action-bar" style="margin-top:10px">
        <button id="logsRefreshBtn" class="btn btn-secondary">Rafraîchir</button>
        <button id="logsExportBtn" class="btn btn-secondary">Export CSV</button>
        <button id="logsDeleteBatchBtn" class="btn btn-secondary">Suppression logs batch</button>
        <button id="logsDeleteAllBtn" class="btn btn-danger">Suppression logs</button>
      </div>
    </div>
    <div class="card">
      <div class="tabs">
        <button class="tab-btn active" data-tab="summaryTab">Synthèse</button>
        <button class="tab-btn" data-tab="streamTab">Flux</button>
        <button class="tab-btn" data-tab="tableTab">Tableau</button>
        <button class="tab-btn" data-tab="auditTab">Audit métier</button>
      </div>
      <div id="summaryTab" class="tab-panel active"></div>
      <div id="streamTab" class="tab-panel"><pre id="logsStream" class="console"></pre></div>
      <div id="tableTab" class="tab-panel"><div class="table-wrap"><table><thead><tr><th>Date</th><th>Scope</th><th>Niveau</th><th>Batch</th><th>Email</th><th>Message</th></tr></thead><tbody id="logsRows"></tbody></table></div></div>
      <div id="auditTab" class="tab-panel" id="auditTimeline"></div>
    </div>`;

  document.querySelectorAll('.tab-btn').forEach((b) => b.addEventListener('click', () => {
    state.logsTab = b.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach((x) => x.classList.toggle('active', x.dataset.tab === state.logsTab));
    document.querySelectorAll('.tab-panel').forEach((x) => x.classList.toggle('active', x.id === state.logsTab));
  }));

  $('logsRefreshBtn').addEventListener('click', refreshLogs);
  $('logsExportBtn').addEventListener('click', () => { window.location.href = `/api/logs/export.csv?${new URLSearchParams(currentLogsFilters()).toString()}`; });
  $('logsDeleteAllBtn').addEventListener('click', () => deleteLogs());
  $('logsDeleteBatchBtn').addEventListener('click', () => deleteLogs(true));
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
    const [logs, summary, batches] = await Promise.all([
      apiGet(`/api/logs${query ? `?${query}` : ''}`),
      apiGet(`/api/logs/summary${query ? `?${query}` : ''}`),
      apiGet('/api/batches').catch(() => ({ items: [] }))
    ]);

    $('logsBatchFilter').innerHTML = `<option value="">Tous</option>${(batches.items || []).map((b) => `<option value="${escapeHtml(b.batch_uuid)}">${escapeHtml(b.batch_uuid)}</option>`).join('')}`;

    $('summaryTab').innerHTML = `<div class="grid-kpi">
      <div class="kpi-card"><div class="label">Total logs</div><div class="value">${summary.total_logs || 0}</div></div>
      <div class="kpi-card"><div class="label">Erreurs</div><div class="value">${summary.by_level?.error || 0}</div></div>
      <div class="kpi-card"><div class="label">Warnings</div><div class="value">${summary.by_level?.warning || 0}</div></div>
      <div class="kpi-card"><div class="label">Dernier log</div><div>${escapeHtml(summary.last_log?.message || 'Aucun')}</div></div>
    </div>`;

    const rows = logs.items || [];
    const textFilter = ($('logsTextSearch').value || '').toLowerCase();
    const filtered = rows.filter((r) => `${r.message || ''} ${r.email || ''}`.toLowerCase().includes(textFilter));
    $('logsRows').innerHTML = filtered.map((r) => `<tr><td>${formatDate(r.created_at)}</td><td>${escapeHtml(r.scope || '')}</td><td>${statusBadge(r.level)}</td><td>${escapeHtml(r.batch_uuid || '')}</td><td>${escapeHtml(r.email || '')}</td><td>${escapeHtml(r.message || '')}</td></tr>`).join('');
    $('logsStream').textContent = filtered.map((r) => `[${formatDate(r.created_at)}] [${(r.level || 'info').toUpperCase()}] ${r.message}`).join('\n');
    $('auditTab').innerHTML = filtered.filter((r) => (r.level || '').toLowerCase() === 'audit').map((a) => `<p>${statusChip('info', a.scope || 'audit')} ${formatDate(a.created_at)} — ${escapeHtml(a.message || '')}</p>`).join('') || '<div class="empty-state">Aucun événement métier.</div>';
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
    const res = await fetch(url, { method: 'DELETE' });
    if (!res.ok) throw new Error('Suppression impossible');
    refreshLogs();
    setToast('Suppression effectuée.');
  } catch (e) { setToast(e.message); }
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
