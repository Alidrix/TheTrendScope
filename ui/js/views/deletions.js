import { apiGet } from '../api.js';
import { state } from '../state.js';
import { $, escapeHtml, setToast, textCell } from '../utils.js';
import { dangerZone } from '../components/danger-zone.js';
import { emptyState } from '../components/empty-state.js';
import { kpiCard } from '../components/kpi-card.js';
import { statusBadge, statusChip } from '../components/status-chip.js';

export function renderDeletionsView() {
  $('deletionsView').innerHTML = `
    <div class="deletions-top-row card compact-bar">
      <div class="top-item min-w-0">
        <label>Delete API</label>
        <div id="deleteConfigStatus" class="muted">Vérification...</div>
      </div>
      <div class="top-item min-w-0">
        <label>Batch</label>
        <select id="deleteBatchSelect"></select>
      </div>
      <div class="top-item min-w-0">
        <label>Dry-run</label>
        <label id="importDryRunToggle" class="toggle-control"><input id="deleteDryRunOnly" type="checkbox" checked/><span class="toggle-slider"></span><span class="toggle-text">Activé</span></label>
      </div>
      <div class="action-bar deletions-actions">
        <button id="deletePreviewBtn" class="btn btn-secondary">Prévisualiser</button>
      </div>
    </div>

    <div class="card">
      <div class="section-header"><h3>Éligibilité</h3><div id="deleteEligibility" class="grid-kpi compact-kpi"></div></div>
      <div class="table-wrap"><table><thead><tr><th>Email</th><th>Batch</th><th>Statut</th><th>Détails</th></tr></thead><tbody id="deleteRows"></tbody></table></div>
    </div>

    ${dangerZone('DangerZone', 'Action irréversible. Vérifiez la prévisualisation avant exécution.', '<div class="action-bar"><span class="muted">Confirmation explicite requise</span><button id="deleteExecuteBtn" class="btn btn-danger" disabled>Suppression réelle</button></div>')}
  `;
  updateDryRunToggle();
  $('deleteDryRunOnly').addEventListener('change', updateDryRunToggle);
  $('deletePreviewBtn').addEventListener('click', () => runDeleteStream(true));
  $('deleteExecuteBtn').addEventListener('click', () => runDeleteStream(false));
}

function updateDryRunToggle() {
  const checked = $('deleteDryRunOnly')?.checked;
  $('importDryRunToggle')?.classList.toggle('off', !checked);
  const text = $('importDryRunToggle')?.querySelector('.toggle-text');
  if (text) text.textContent = checked ? 'Activé' : 'Désactivé';
}

export async function refreshDeleteConfig() {
  try {
    const [cfg, batches] = await Promise.all([apiGet('/api/delete-config-status').catch(() => ({})), apiGet('/api/batches').catch(() => ({ items: [] }))]);
    $('deleteConfigStatus').innerHTML = cfg.configured ? statusChip('operational', 'Configurée') : statusChip('error', 'Non configurée', cfg.message || '');
    $('deleteBatchSelect').innerHTML = `<option value="__latest__">Dernier batch</option>${(batches.items || []).map((b) => `<option value="${escapeHtml(b.batch_uuid)}">${escapeHtml(b.batch_uuid)} — ${escapeHtml(b.filename || 'Sans fichier')}</option>`).join('')}`;
  } catch (e) { setToast(`Configuration suppression indisponible: ${e.message}`); }
}

async function runDeleteStream(previewOnly) {
  const selected = $('deleteBatchSelect').value;
  const body = { dry_run_only: previewOnly || $('deleteDryRunOnly').checked };
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
  $('deleteEligibility').innerHTML = Object.keys(counts).length ? Object.entries(counts).map(([k, v]) => kpiCard(k, v)).join('') : emptyState('Aucune donnée.');
}
