const fileInput = document.getElementById('file');
const uploadBtn = document.getElementById('uploadBtn');
const deleteBatchSelect = document.getElementById('deleteBatchSelect');
const deleteDryRunOnly = document.getElementById('deleteDryRunOnly');
const deletePreviewBtn = document.getElementById('deletePreviewBtn');
const deleteExecuteBtn = document.getElementById('deleteExecuteBtn');
const deleteResultsRows = document.getElementById('deleteResultsRows');
const deleteEligibilitySummary = document.getElementById('deleteEligibilitySummary');
const rollbackInput = document.getElementById('rollbackOnError');
const resultsBody = document.getElementById('results');
const usersRows = document.getElementById('usersRows');
const usersEmpty = document.getElementById('usersEmpty');
const summary = document.getElementById('summary');
const finalSummary = document.getElementById('finalSummary');
const bar = document.getElementById('bar');
const progressPercent = document.getElementById('progressPercent');
const progressStage = document.getElementById('progressStage');
const toast = document.getElementById('toast');
const logsBox = document.getElementById('logs');
const menuItems = document.querySelectorAll('.menu-item');
const viewSections = document.querySelectorAll('.view-section');
const dbSummary = document.getElementById('dbSummary');
const batchesRows = document.getElementById('batchesRows');
const batchesEmpty = document.getElementById('batchesEmpty');
const selectedBatchTitle = document.getElementById('selectedBatchTitle');
const batchUsersRows = document.getElementById('batchUsersRows');
const lastImportSummary = document.getElementById('lastImportSummary');

let latestResults = [];

function setToastType(type = 'info') {
  toast.className = `toast toast-${type}`;
}

function showToast(message, type = 'info') {
  setToastType(type);
  toast.textContent = message;
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; }, 3000);
}

function switchView(viewId) {
  viewSections.forEach((section) => section.classList.toggle('active-view', section.id === viewId));
  menuItems.forEach((item) => item.classList.toggle('active', item.dataset.view === viewId));
  if (viewId === 'historyView') {
    refreshHistoryData();
  }
}

menuItems.forEach((item) => {
  item.addEventListener('click', (event) => {
    event.preventDefault();
    switchView(item.dataset.view);
  });
});

function appendLog(kind, message, meta = null) {
  const time = new Date().toLocaleTimeString();
  const metaText = meta ? ` | ${JSON.stringify(meta)}` : '';
  logsBox.textContent += `[${time}] [${kind}] ${message}${metaText}\n`;
  logsBox.scrollTop = logsBox.scrollHeight;
}

function appendAudit(payload) {
  const level = (payload?.level || 'info').toUpperCase();
  appendLog(`AUDIT-${level}`, payload?.message || payload?.code || 'event', {
    code: payload?.code,
    row: payload?.row,
    email: payload?.email,
    group: payload?.group,
    reason: payload?.reason,
    status: payload?.status
  });
}

function stageLabel(stage) {
  return {
    'preview': 'Prévalidation',
    'create-user': 'Création utilisateur',
    'create-group': 'Création groupe',
    'assign-group': 'Assignation groupe',
    'delete': 'Suppression',
    'dry-run': 'Dry-run',
    'lookup': 'Lookup',
    'load-batch': 'Chargement batch',
    'done': 'Terminé'
  }[stage] || stage;
}

function setProgress(percent, stage = 'preview') {
  bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  progressPercent.textContent = `${Math.round(percent)}%`;
  progressStage.textContent = stageLabel(stage);
  bar.classList.toggle('done', stage === 'done');
}

function statusBadge(status) {
  if (status === 'success' || status === 'completed' || status === 'created' || status === 'pending_activation') return '<span class="badge badge-success">succès</span>';
  if (status === 'partial' || status === 'deferred') return '<span class="badge badge-warning">partiel/différé</span>';
  if (status === 'error' || status === 'failed') return '<span class="badge badge-error">erreur</span>';
  if (status === 'skipped') return '<span class="badge badge-info">non complet</span>';
  if (status === 'rolled_back' || status === 'rollback_required_manual') return '<span class="badge badge-info">rollback</span>';
  return `<span class="badge badge-info">${status || 'n/a'}</span>`;
}

function escapeHtml(text) {
  return (text || '').toString().replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function renderUsersPanel() {
  usersRows.innerHTML = '';
  if (!latestResults.length) {
    usersEmpty.style.display = 'block';
    return;
  }
  usersEmpty.style.display = 'none';
  latestResults.forEach((row) => {
    const groups = row.groups_assigned?.length ? row.groups_assigned : (row.groups_requested || []);
    usersRows.insertAdjacentHTML('beforeend', `
      <tr>
        <td>${escapeHtml(row.email)}</td>
        <td>${escapeHtml(row.raw?.command?.includes('-r admin') ? 'admin' : 'user')}</td>
        <td>${statusBadge(row.user_create_status === 'success' && row.groups_deferred?.length ? 'deferred' : row.user_create_status)}</td>
        <td>${escapeHtml(groups.join(', '))}</td>
      </tr>
    `);
  });
}

function renderImportResults(payload) {
  resultsBody.innerHTML = '';
  latestResults = payload.results || [];

  latestResults.forEach((row) => {
    const detail = [
      row.errors?.length ? `Erreurs: ${row.errors.join(' | ')}` : '',
      row.groups_created?.length ? `Groupes créés: ${row.groups_created.join(', ')}` : '',
      row.groups_assigned?.length ? `Groupes assignés: ${row.groups_assigned.join(', ')}` : '',
      row.groups_deferred?.length ? `Groupes différés: ${row.groups_deferred.join(', ')}` : ''
    ].filter(Boolean).join('<br>') || '-';

    resultsBody.insertAdjacentHTML('beforeend', `
      <tr>
        <td>${escapeHtml(row.email)}</td>
        <td>${statusBadge(row.user_create_status === 'success' && row.groups_deferred?.length ? 'deferred' : row.user_create_status)}</td>
        <td>${escapeHtml((row.groups_requested || []).join(', '))}</td>
        <td>${detail}</td>
      </tr>
    `);
  });

  const sum = payload.summary || {};
  finalSummary.innerHTML = `
    <li>Utilisateurs créés: <strong>${sum.users_created || 0}</strong></li>
    <li>Groupes créés: <strong>${sum.groups_created || 0}</strong></li>
    <li>Groupes assignés: <strong>${sum.groups_assigned || 0}</strong></li>
    <li>Assignations différées: <strong>${sum.groups_deferred || 0}</strong></li>
    <li>Erreurs: <strong>${sum.errors || 0}</strong></li>
    <li>Batch UUID: <strong>${escapeHtml(payload.batch_uuid || '-')}</strong></li>
  `;

  renderUsersPanel();
  summary.textContent = `Import ${payload.status} — ${payload.success}/${payload.total}`;
}

function formatDate(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

async function apiGet(path) {
  const response = await fetch(path);
  const raw = await response.text();
  let payload = null;

  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch (error) {
    const snippet = raw.slice(0, 120).replace(/\n/g, ' ');
    throw new Error(`Réponse non JSON sur ${path} (HTTP ${response.status})${snippet ? `: ${snippet}` : ''}`);
  }

  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
  return payload;
}

function renderDbSummary(summaryPayload) {
  const last = summaryPayload?.last_batch;
  dbSummary.innerHTML = `
    <div class="stat-item"><span>Total batches</span><strong>${summaryPayload?.batches_count || 0}</strong></div>
    <div class="stat-item"><span>Total users tracked</span><strong>${summaryPayload?.tracked_users_count || 0}</strong></div>
    <div class="stat-item"><span>Users créés par l'outil</span><strong>${summaryPayload?.tool_created_count || 0}</strong></div>
    <div class="stat-item"><span>Deletable candidates</span><strong>${summaryPayload?.deletable_candidates_count || 0}</strong></div>
    <div class="stat-item stat-wide"><span>Last batch</span><strong>${escapeHtml(last?.batch_uuid || 'Aucun')}</strong></div>
  `;
}

function renderLastImportBlock(latestBatch, users = []) {
  const pendingCount = users.filter((user) => user.import_status === 'pending_activation').length;
  const deletableCount = users.filter((user) => Number(user.deletable_candidate) === 1).length;
  if (!latestBatch) {
    lastImportSummary.innerHTML = '<li>Aucun import enregistré.</li>';
    return;
  }
  lastImportSummary.innerHTML = `
    <li>Fichier CSV: <strong>${escapeHtml(latestBatch.filename)}</strong></li>
    <li>Date: <strong>${formatDate(latestBatch.created_at)}</strong></li>
    <li>Utilisateurs créés: <strong>${latestBatch.success_count || 0}</strong></li>
    <li>Erreurs: <strong>${latestBatch.error_count || 0}</strong></li>
    <li>Comptes pending: <strong>${pendingCount}</strong></li>
    <li>Comptes potentiellement supprimables: <strong>${deletableCount}</strong></li>
  `;
}

function renderBatches(items) {
  batchesRows.innerHTML = '';
  if (deleteBatchSelect) {
    const options = ['<option value="__latest__">Dernier import (défaut)</option>'];
    items.forEach((item) => { options.push(`<option value="${escapeHtml(item.batch_uuid)}">${escapeHtml(item.batch_uuid)} | ${escapeHtml(item.filename)}</option>`); });
    deleteBatchSelect.innerHTML = options.join('');
  }
  if (!items.length) {
    batchesEmpty.style.display = 'block';
    return;
  }
  batchesEmpty.style.display = 'block';
  batchesEmpty.textContent = 'Cliquez sur "Voir" pour ouvrir le détail d\'un batch.';
  items.forEach((item) => {
    batchesRows.insertAdjacentHTML('beforeend', `
      <tr>
        <td>${escapeHtml(item.batch_uuid)}</td>
        <td>${escapeHtml(item.filename)}</td>
        <td>${escapeHtml(formatDate(item.created_at))}</td>
        <td>${item.total_rows}</td>
        <td>${item.success_count}</td>
        <td>${item.error_count}</td>
        <td>${statusBadge(item.status)}</td>
        <td><button type="button" class="btn-primary btn-small" data-batch="${escapeHtml(item.batch_uuid)}">Voir</button></td>
      </tr>
    `);
  });

  document.querySelectorAll('[data-batch]').forEach((button) => {
    button.addEventListener('click', async () => {
      await loadBatchDetails(button.dataset.batch);
    });
  });
}

function renderBatchUsers(batchUuid, users) {
  selectedBatchTitle.textContent = `Batch sélectionné: ${batchUuid}`;
  batchUsersRows.innerHTML = '';
  users.forEach((user) => {
    const link = user.activation_link ? `<a href="${escapeHtml(user.activation_link)}" target="_blank" rel="noopener noreferrer">ouvrir</a>` : '-';
    batchUsersRows.insertAdjacentHTML('beforeend', `
      <tr>
        <td>${escapeHtml(user.email)}</td>
        <td>${escapeHtml(user.firstname || '')}</td>
        <td>${escapeHtml(user.lastname || '')}</td>
        <td>${escapeHtml(user.requested_role || '')}</td>
        <td>${statusBadge(user.import_status)}</td>
        <td>${link}</td>
        <td>${escapeHtml(user.last_known_activation_state || '')}</td>
        <td>${Number(user.deletable_candidate) === 1 ? '1' : '0'}</td>
        <td>${Number(user.created_by_tool) === 1 ? '1' : '0'}</td>
      </tr>
    `);
  });
}

async function loadBatchDetails(batchUuid) {
  try {
    const payload = await apiGet(`/batches/${encodeURIComponent(batchUuid)}`);
    renderBatchUsers(batchUuid, payload.users || []);
  } catch (error) {
    appendLog('ERR', `Chargement batch impossible: ${error.message || String(error)}`);
    showToast('Erreur chargement batch', 'error');
  }
}

async function refreshHistoryData() {
  try {
    const [summaryPayload, batchesPayload] = await Promise.all([
      apiGet('/db/summary'),
      apiGet('/batches')
    ]);

    renderDbSummary(summaryPayload);
    const items = batchesPayload?.items || [];
    renderBatches(items);

    const latest = summaryPayload?.last_batch;
    if (latest?.batch_uuid) {
      const latestDetails = await apiGet(`/batches/${encodeURIComponent(latest.batch_uuid)}`);
      renderLastImportBlock(latest, latestDetails.users || []);
      renderBatchUsers(latest.batch_uuid, latestDetails.users || []);
    } else {
      renderLastImportBlock(null, []);
      selectedBatchTitle.textContent = 'Sélectionnez un batch pour afficher les utilisateurs.';
      batchUsersRows.innerHTML = '';
    }
  } catch (error) {
    appendLog('ERR', `Historique indisponible: ${error.message || String(error)}`);
    showToast('Impossible de charger l’historique', 'warning');
  }
}


function deleteStatusBadge(status) {
  return `<span class="badge badge-delete badge-${escapeHtml(status || 'ERROR')}">${escapeHtml(status || 'n/a')}</span>`;
}

function renderDeleteResults(items = []) {
  deleteResultsRows.innerHTML = '';
  items.forEach((row) => {
    deleteResultsRows.insertAdjacentHTML('beforeend', `
      <tr>
        <td>${escapeHtml(row.email)}</td>
        <td>${escapeHtml(row.batch_uuid)}</td>
        <td>${row.found ? '1' : '0'}</td>
        <td>${escapeHtml(row.user_id || '')}</td>
        <td>${escapeHtml(row.actual_role || '')}</td>
        <td>${escapeHtml(row.activation_state || '')}</td>
        <td>${deleteStatusBadge(row.status)}</td>
        <td>${escapeHtml(row.message || '')}</td>
      </tr>
    `);
  });
}

function renderDeleteEligibility(items = []) {
  const counts = {};
  items.forEach((item) => {
    const key = item.status || 'UNKNOWN';
    counts[key] = (counts[key] || 0) + 1;
  });
  const deleted = counts.DELETED || 0;
  const excluded = (counts.SKIPPED_ADMIN || 0) + (counts.SKIPPED_NOT_TOOL_MANAGED || 0) + (counts.SKIPPED_ACTIVE_USER || 0);
  deleteEligibilitySummary.innerHTML = `
    <li>Eligibles / supprimés: <strong>${deleted}</strong></li>
    <li>Exclus: <strong>${excluded}</strong></li>
    <li>SKIPPED_ADMIN: <strong>${counts.SKIPPED_ADMIN || 0}</strong></li>
    <li>SKIPPED_NOT_TOOL_MANAGED: <strong>${counts.SKIPPED_NOT_TOOL_MANAGED || 0}</strong></li>
    <li>SKIPPED_ACTIVE_USER: <strong>${counts.SKIPPED_ACTIVE_USER || 0}</strong></li>
    <li>BLOCKED_BY_PASSBOLT: <strong>${counts.BLOCKED_BY_PASSBOLT || 0}</strong></li>
    <li>NOT_FOUND: <strong>${counts.NOT_FOUND || 0}</strong></li>
    <li>ERROR: <strong>${counts.ERROR || 0}</strong></li>
  `;
}

function resolveDeleteBatchSelection() {
  const selected = deleteBatchSelect?.value || '__latest__';
  if (selected === '__latest__') return null;
  return selected;
}

async function runDelete(previewOnly = false) {
  deletePreviewBtn.disabled = true;
  deleteExecuteBtn.disabled = true;
  try {
    const body = {
      dry_run_only: previewOnly || Boolean(deleteDryRunOnly?.checked)
    };
    const batchUuid = resolveDeleteBatchSelection();
    if (batchUuid) body.batch_uuid = batchUuid;

    const response = await fetch('/delete-users-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response.ok || !response.body) throw new Error('Delete stream indisponible');

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
        const trimmed = line.trim();
        if (!trimmed) continue;
        const event = JSON.parse(trimmed);
        if (event.type === 'log') appendLog('INFO', event.message);
        if (event.type === 'stderr') appendLog('ERR', event.message);
        if (event.type === 'progress') {
          const payload = event.payload || {};
          setProgress(payload.percent || 0, payload.stage || 'preview');
        }
        if (event.type === 'final') {
          const payload = event.payload || {};
          renderDeleteResults(payload.results || []);
          renderDeleteEligibility(payload.results || []);
          appendLog('INFO', 'Delete batch terminé', { batch_uuid: payload.batch_uuid, status: payload.status, dry_run_only: payload.dry_run_only });
          showToast(payload.dry_run_only ? 'Prévisualisation suppression terminée' : 'Suppression terminée', payload.status === 'success' ? 'success' : 'warning');
          await refreshHistoryData();
        }
      }
    }
  } catch (error) {
    appendLog('ERR', error.message || String(error));
    showToast('Erreur suppression', 'error');
  } finally {
    deletePreviewBtn.disabled = false;
    deleteExecuteBtn.disabled = false;
  }
}

deletePreviewBtn?.addEventListener('click', () => runDelete(true));
deleteExecuteBtn?.addEventListener('click', () => runDelete(false));

uploadBtn.addEventListener('click', async () => {
  const file = fileInput.files[0];
  if (!file) return showToast('Sélectionne un CSV', 'warning');

  uploadBtn.disabled = true;
  resultsBody.innerHTML = '';
  logsBox.textContent = '';
  finalSummary.innerHTML = '';
  setProgress(5, 'preview');
  switchView('importView');

  const form = new FormData();
  form.append('file', file);
  form.append('rollback_on_error', String(rollbackInput.checked));

  try {
    const response = await fetch('/import-stream', { method: 'POST', body: form });
    if (!response.ok || !response.body) throw new Error('Stream indisponible');

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
        const trimmed = line.trim();
        if (!trimmed) continue;
        const event = JSON.parse(trimmed);
        if (event.type === 'log') appendLog('INFO', event.message);
        if (event.type === 'stderr') appendLog('ERR', event.message);
        if (event.type === 'stdout') appendLog('OUT', event.message);
        if (event.type === 'audit') appendAudit(event.payload || {});
        if (event.type === 'progress') {
          const payload = event.payload || {};
          setProgress(payload.percent || 0, payload.stage || 'preview');
          appendLog('PROGRESS', `${payload.percent || 0}% - ${stageLabel(payload.stage || 'preview')}`, payload);
        }
        if (event.type === 'final') {
          setProgress(100, 'done');
          renderImportResults(event.payload);
          appendLog('INFO', 'Import stream terminé', { status: event.payload?.status, success: event.payload?.success, total: event.payload?.total, batch_uuid: event.payload?.batch_uuid });
          showToast('Import terminé', 'success');
          refreshHistoryData();
        }
      }
    }
  } catch (error) {
    appendLog('ERR', error.message || String(error));
    summary.textContent = 'Import interrompu';
    setProgress(100, 'done');
    bar.classList.remove('done');
    showToast('Erreur import', 'error');
  } finally {
    uploadBtn.disabled = false;
  }
});

refreshHistoryData();
