import { state } from '../state.js';
import { $, escapeHtml, setToast, textCell } from '../utils.js';
import { kpiCard } from '../components/kpi-card.js';
import { appendConsoleLine } from '../components/console-panel.js';
import { statusBadge } from '../components/status-chip.js';
import { apiGet, apiPost } from '../api.js';

export function renderImporterView() {
  $('importerView').innerHTML = `
    <div class="import-shell-grid">
      <section class="card">
        <div class="drop-zone">
          <label for="importFile" class="muted">Déposez ou sélectionnez un fichier CSV</label>
          <input id="importFile" type="file" accept=".csv"/>
        </div>
        <div class="action-bar mt-3"><button class="btn btn-primary" id="importStartBtn">Démarrer l'import</button></div>
        <div class="action-bar mt-2">
          <button class="btn btn-secondary" id="retryAssignmentsBtn">Relancer les assignations en attente</button>
          <span class="muted" id="pendingAssignmentsInfo">Chargement…</span>
        </div>
      </section>

      <section class="card">
        <div class="section-header"><span class="muted" id="importProgressLabel">Prêt</span></div>
        <div id="importProgressWrap" class="progress-track"><div class="progress-bar" id="importProgressBar"></div></div>
        <p class="muted mt-3">Console technique</p>
        <pre class="console" id="importConsole"></pre>
      </section>
    </div>

    <section class="card">
      <div id="importSummaryCards" class="grid-kpi"></div>
      <div class="table-wrap mt-3"><table><thead><tr><th>Email</th><th>Statut</th><th>Groupes demandés</th><th>Détails</th></tr></thead><tbody id="importResultsRows"></tbody></table></div>
    </section>
  `;
  $('importStartBtn').addEventListener('click', runImportFlow);
  $('retryAssignmentsBtn').addEventListener('click', retryPendingAssignments);
  refreshPendingAssignmentsInfo();
}

function setImportProgress(percent, stage) {
  const safePercent = Math.max(0, Math.min(100, percent || 0));
  $('importProgressBar').style.width = `${safePercent}%`;
  $('importProgressWrap').style.display = safePercent >= 100 ? 'none' : 'block';
  $('importProgressLabel').textContent = `${safePercent}% · ${stage || 'running'}`;
}

async function readResponsePayload(res) {
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { message: text }; }
}

function appendImportEventLine(event) {
  if (['log', 'stderr', 'stdout'].includes(event.type)) {
    appendConsoleLine('importConsole', `${event.type.toUpperCase()} | ${event.message || ''}`);
    return;
  }
  if (event.type === 'audit' && event.payload) {
    const level = (event.payload.level || 'info').toUpperCase();
    const msg = event.payload.message || event.payload.code || 'audit event';
    appendConsoleLine('importConsole', `${level} | ${msg}`);
  }
}

async function runImportFlow() {
  const f = $('importFile').files?.[0];
  if (!f) return setToast('Sélectionnez un CSV.', 'warning');
  $('importStartBtn').disabled = true;
  $('importConsole').textContent = '';
  $('importProgressWrap').style.display = 'block';
  setImportProgress(0, 'prévalidation');
  try {
    const form = new FormData();
    form.append('file', f);
    form.append('dry_run_only', 'true');

    const res = await fetch('/api/import-stream', { method: 'POST', body: form });
    if (!res.ok) {
      const payload = await readResponsePayload(res);
      const reason = payload?.error || payload?.message || `HTTP ${res.status}`;
      throw new Error(`Flux import indisponible (${reason})`);
    }
    if (!res.body) throw new Error('Flux import indisponible (stream non supporté)');

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
        appendImportEventLine(event);
        if (event.type === 'progress') {
          const p = event.payload || {};
          setImportProgress(p.percent || 0, p.stage || 'preview');
        }
        if (event.type === 'final') renderImportFinal(event.payload || {});
      }
    }
    setToast('Import terminé.', 'success');
    refreshPendingAssignmentsInfo();
  } catch (e) { setToast(`Erreur import: ${e.message}`, 'error'); }
  finally { $('importStartBtn').disabled = false; }
}

async function refreshPendingAssignmentsInfo() {
  try {
    const payload = await apiGet('/api/pending-group-assignments');
    $('pendingAssignmentsInfo').textContent = `${payload.total || 0} assignation(s) en attente`;
  } catch {
    $('pendingAssignmentsInfo').textContent = 'Statut des assignations en attente indisponible';
  }
}

async function retryPendingAssignments() {
  $('retryAssignmentsBtn').disabled = true;
  try {
    const payload = await apiPost('/api/retry-pending-group-assignments');
    const retried = payload.retried?.length || 0;
    const pending = payload.pending_total || 0;
    setToast(`Assignations relancées: ${retried}, en attente: ${pending}`, 'success');
    refreshPendingAssignmentsInfo();
  } catch (e) {
    setToast(`Relance impossible: ${e.message}`, 'error');
  } finally {
    $('retryAssignmentsBtn').disabled = false;
  }
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
  $('importSummaryCards').innerHTML = cards.map(([label, value]) => kpiCard(label, value)).join('');
  $('importResultsRows').innerHTML = state.latestImportResults.map((row) => {
    const detail = [
      row.group_messages?.length ? row.group_messages.join(' | ') : '',
      row.errors?.length ? `Erreurs: ${row.errors.join(' | ')}` : '',
      row.groups_created?.length ? `Groupes créés: ${row.groups_created.join(', ')}` : '',
      row.groups_assigned?.length ? `Groupes assignés: ${row.groups_assigned.join(', ')}` : '',
      row.groups_deferred?.length ? `Groupes en attente: ${row.groups_deferred.join(', ')}` : ''
    ].filter(Boolean).join(' • ') || '-';
    return `<tr><td>${textCell(row.email)}</td><td>${statusBadge(row.user_create_status)}</td><td>${textCell((row.groups_requested || []).join(', '))}</td><td>${textCell(escapeHtml(detail))}</td></tr>`;
  }).join('');
}
