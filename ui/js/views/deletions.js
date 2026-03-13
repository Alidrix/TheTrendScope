import { apiGet } from '../api.js';
import { state } from '../state.js';
import { $, escapeHtml, setToast, textCell } from '../utils.js';
import { pageHeader } from '../components/page-header.js';
import { dangerZone } from '../components/danger-zone.js';
import { emptyState } from '../components/empty-state.js';
import { kpiCard } from '../components/kpi-card.js';
import { statusBadge, statusChip } from '../components/status-chip.js';

export function renderDeletionsView() {
  $('deletionsView').innerHTML = `${pageHeader('Suppressions', 'Zone sensible : suppression par batch avec garde-fous visuels.')}<div class="grid-two"><div class="card"><div class="section-header"><h3>Préparation</h3></div><p id="deleteConfigStatus" class="muted">Vérification...</p><div class="form-grid"><div><label>Batch cible</label><select id="deleteBatchSelect"></select></div><div><label><input id="deleteDryRunOnly" type="checkbox" checked/> Dry-run uniquement</label></div></div><div class="action-bar mt-3"><button id="deletePreviewBtn" class="btn btn-secondary">Prévisualiser</button></div></div>${dangerZone('Danger zone', 'Cette action est irréversible. Confirmez uniquement après vérification de l\'éligibilité.', '<button id="deleteExecuteBtn" class="btn btn-danger" disabled>Supprimer réellement</button>')}</div><div class="card"><div class="section-header"><h3>Prévisualisation d’éligibilité</h3></div><div id="deleteEligibility" class="grid-kpi"></div></div><div class="card"><div class="section-header"><h3>Retour d’exécution live</h3></div><div class="table-wrap"><table><thead><tr><th>Email</th><th>Batch</th><th>Statut</th><th>Détails</th></tr></thead><tbody id="deleteRows"></tbody></table></div></div>`;
  $('deletePreviewBtn').addEventListener('click', () => runDeleteStream(true));
  $('deleteExecuteBtn').addEventListener('click', () => runDeleteStream(false));
}

export async function refreshDeleteConfig() {
  try {
    const [cfg, batches] = await Promise.all([apiGet('/api/delete-config-status').catch(() => ({})), apiGet('/api/batches').catch(() => ({ items: [] }))]);
    $('deleteConfigStatus').innerHTML = cfg.configured ? statusChip('operational', 'Delete API configurée') : statusChip('error', 'Delete API non configurée', cfg.message || '');
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
