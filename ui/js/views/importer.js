import { STAGES, state } from '../state.js';
import { $, escapeHtml, setToast, textCell } from '../utils.js';
import { apiGet } from '../api.js';
import { pageHeader } from '../components/page-header.js';
import { kpiCard } from '../components/kpi-card.js';
import { renderStepper } from '../components/progress-stepper.js';
import { appendConsoleLine } from '../components/console-panel.js';
import { statusBadge } from '../components/status-chip.js';

export function renderImporterView() {
  $('importerView').innerHTML = `${pageHeader('Importer', 'Workflow guidé pour un import CSV robuste et traçable.')}<div class="grid-two"><div class="card"><div class="section-header"><h3>Dépôt CSV</h3><p>1 fichier = 1 batch</p></div><div class="drop-zone"><input id="importFile" type="file" accept=".csv"/></div><div class="form-grid mt-3"><div><label>Nom de lot (optionnel)</label><input id="importBatchLabel" placeholder="Ex: RH-Mars"/></div><div><label><input id="importDryRun" type="checkbox" checked/> Prévalidation uniquement</label></div></div><div class="action-bar mt-3"><button class="btn btn-primary" id="importStartBtn">Démarrer l'import</button></div></div><div class="card"><div class="section-header"><h3>Progression live</h3></div><div class="stepper" id="importStepper"></div><div class="progress-track mt-3"><div class="progress-bar" id="importProgressBar"></div></div><p id="simpleRunSummary" class="muted mt-3 text-break">En attente d'exécution.</p><details class="mt-3"><summary>Console technique</summary><pre class="console" id="importConsole"></pre></details></div></div><div class="card"><div class="section-header"><h3>Résultats finaux</h3></div><div id="importSummaryCards" class="grid-kpi"></div><div class="table-wrap mt-3"><table><thead><tr><th>Email</th><th>Statut</th><th>Groupes demandés</th><th>Détails</th></tr></thead><tbody id="importResultsRows"></tbody></table></div></div>`;
  renderStepper('importStepper', STAGES, 'preview');
  $('importStartBtn').addEventListener('click', runImportFlow);
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
  renderStepper('importStepper', STAGES, 'preview');
  setImportProgress(0, 'prévalidation');
  try {
    await apiGet('/api/health');
    const form = new FormData();
    form.append('file', f);
    const label = $('importBatchLabel')?.value?.trim();
    if (label) form.append('batch_label', label);
    form.append('dry_run_only', $('importDryRun').checked ? 'true' : 'false');

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
        if (['log', 'stderr', 'stdout'].includes(event.type)) appendConsoleLine('importConsole', `${event.type.toUpperCase()} | ${event.message}`);
        if (event.type === 'progress') {
          const p = event.payload || {};
          renderStepper('importStepper', STAGES, p.stage || 'preview');
          setImportProgress(p.percent || 0, p.stage || 'preview');
        }
        if (event.type === 'final') renderImportFinal(event.payload || {});
      }
    }
    setToast('Import terminé.');
  } catch (e) { setToast(`Erreur import: ${e.message}`); }
  finally { $('importStartBtn').disabled = false; }
}

function renderImportFinal(payload) {
  state.latestImportResults = payload.results || [];
  const s = payload.summary || {};
  const cards = [['Utilisateurs créés', s.users_created || 0], ['Groupes créés', s.groups_created || 0], ['Groupes assignés', s.groups_assigned || 0], ['Erreurs', s.errors || 0], ['Batch', payload.batch_uuid || '-']];
  $('importSummaryCards').innerHTML = cards.map(([label, value]) => kpiCard(label, value)).join('');
  $('importResultsRows').innerHTML = state.latestImportResults.map((row) => {
    const detail = [row.errors?.length ? `Erreurs: ${row.errors.join(' | ')}` : '', row.groups_created?.length ? `Groupes créés: ${row.groups_created.join(', ')}` : '', row.groups_assigned?.length ? `Groupes assignés: ${row.groups_assigned.join(', ')}` : ''].filter(Boolean).join(' • ') || '-';
    return `<tr><td>${textCell(row.email)}</td><td>${statusBadge(row.user_create_status)}</td><td>${textCell((row.groups_requested || []).join(', '))}</td><td>${textCell(escapeHtml(detail))}</td></tr>`;
  }).join('');
}
