const fileInput = document.getElementById('file');
const uploadBtn = document.getElementById('uploadBtn');
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

let latestResults = [];

function setToastType(type = 'info') {
  toast.className = `toast toast-${type}`;
}

function showToast(message, type = 'info') {
  setToastType(type);
  toast.textContent = message;
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; }, 2500);
}

function switchView(viewId) {
  viewSections.forEach((section) => {
    section.classList.toggle('active-view', section.id === viewId);
  });
  menuItems.forEach((item) => {
    item.classList.toggle('active', item.dataset.view === viewId);
  });
}

menuItems.forEach((item) => {
  item.addEventListener('click', (event) => {
    event.preventDefault();
    switchView(item.dataset.view);
  });
});

function appendLog(prefix, message) {
  logsBox.textContent += `[${new Date().toLocaleTimeString()}] ${prefix} ${message}\n`;
  logsBox.scrollTop = logsBox.scrollHeight;
}

function stageLabel(stage) {
  const map = {
    'preview': 'Prévalidation',
    'create-user': 'Création utilisateur',
    'create-group': 'Création groupe',
    'assign-group': 'Assignation groupe',
    'done': 'Terminé'
  };
  return map[stage] || stage;
}

function setProgress(percent, stage = 'preview') {
  bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  progressPercent.textContent = `${Math.round(percent)}%`;
  progressStage.textContent = stageLabel(stage);
  if (stage === 'done') {
    bar.classList.add('done');
  } else {
    bar.classList.remove('done');
  }
}

function statusBadge(status) {
  if (status === 'success') return '<span class="badge badge-success">succès</span>';
  if (status === 'partial' || status === 'deferred') return '<span class="badge badge-warning">partiel/différé</span>';
  if (status === 'error' || status === 'failed') return '<span class="badge badge-error">erreur</span>';
  if (status === 'rolled_back' || status === 'rollback_required_manual') return '<span class="badge badge-info">rollback</span>';
  return `<span class="badge badge-info">${status || 'n/a'}</span>`;
}

function escapeHtml(text) {
  return (text || '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function renderUsersPanel() {
  usersRows.innerHTML = '';
  if (!latestResults.length) {
    usersEmpty.style.display = 'block';
    return;
  }

  usersEmpty.style.display = 'none';
  latestResults.forEach((row) => {
    const groups = (row.groups_assigned && row.groups_assigned.length)
      ? row.groups_assigned
      : (row.groups_requested || []);

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
  const rows = payload.results || [];
  latestResults = rows;

  rows.forEach((row) => {
    const detail = [
      row.errors && row.errors.length ? `Erreurs: ${row.errors.join(' | ')}` : '',
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
  `;

  renderUsersPanel();
  summary.textContent = `Import ${payload.status} — ${payload.success}/${payload.total}`;
}

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
        if (event.type === 'progress') {
          const payload = event.payload || {};
          setProgress(payload.percent || 0, payload.stage || 'preview');
        }
        if (event.type === 'final') {
          setProgress(100, 'done');
          renderImportResults(event.payload);
          showToast('Import terminé', 'success');
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
