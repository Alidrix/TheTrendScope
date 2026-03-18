import { apiGet } from '../api.js';
import { state } from '../state.js';
import { $, escapeHtml, formatDate, setToast } from '../utils.js';
import { emptyState } from '../components/empty-state.js';
import { statusBadge } from '../components/status-chip.js';
import { kpiCard } from '../components/kpi-card.js';
import { pageHeader } from '../components/page-header.js';

export function renderHistoryView() {
  $('historyView').innerHTML = `
    ${pageHeader('Historique')}
    <div class="master-detail">
      <section class="card">
        <div class="form-grid">
          <div><label>Recherche</label><input id="historySearch" placeholder="UUID, fichier..." /></div>
          <div><label>Tri</label><select id="historySort"><option value="date_desc">Date ↓</option><option value="date_asc">Date ↑</option><option value="errors_desc">Erreurs ↓</option></select></div>
        </div>
        <div class="batch-list mt-3" id="batchList"></div>
      </section>
      <section class="card" id="historyDetail"></section>
    </div>
  `;

  $('historySearch').addEventListener('input', () => {
    state.historySearch = $('historySearch').value.toLowerCase();
    renderHistoryList();
  });
  $('historySort').addEventListener('change', () => {
    state.historySort = $('historySort').value;
    renderHistoryList();
  });
}

export async function refreshHistory() {
  try {
    const batches = await apiGet('/api/batches').catch(() => ({ items: [] }));
    state.batches = batches.items || [];
    if (!state.activeBatch && state.batches.length) state.activeBatch = state.batches[0].batch_uuid;
    renderHistoryList();
  } catch (e) { setToast(`Historique indisponible: ${e.message}`, 'error'); }
}

function renderHistoryList() {
  const rows = [...state.batches]
    .filter((b) => `${b.batch_uuid || ''} ${b.filename || ''}`.toLowerCase().includes(state.historySearch))
    .sort((a, b) => {
      if (state.historySort === 'date_asc') return new Date(a.created_at) - new Date(b.created_at);
      if (state.historySort === 'errors_desc') return (b.errors_count || 0) - (a.errors_count || 0);
      return new Date(b.created_at) - new Date(a.created_at);
    });

  $('batchList').innerHTML = rows.map((b) => `
    <button class="batch-item ${b.batch_uuid === state.activeBatch ? 'active' : ''}" data-batch="${escapeHtml(b.batch_uuid)}">
      <p class="text-ellipsis"><strong>${escapeHtml(b.filename || 'Sans nom')}</strong></p>
      <p class="muted text-ellipsis">${formatDate(b.created_at)}</p>
      <p class="muted text-break">${escapeHtml(b.batch_uuid || '-')}</p>
    </button>
  `).join('') || emptyState('Aucun batch.');

  document.querySelectorAll('.batch-item').forEach((item) => item.addEventListener('click', () => {
    state.activeBatch = item.dataset.batch;
    renderHistoryList();
  }));

  const selected = state.batches.find((b) => b.batch_uuid === state.activeBatch);
  $('historyDetail').innerHTML = selected
    ? `
      <div class="section-header"><h3>Lot actif</h3>${statusBadge(selected.status)}</div>
      <div class="grid-kpi">
        ${kpiCard('Succès', selected.success_count || 0)}
        ${kpiCard('Erreurs', selected.errors_count || 0)}
        ${kpiCard('Assignations groupes', selected.group_assignments || 0)}
      </div>
      <p class="muted mt-3 text-break">UUID: ${escapeHtml(selected.batch_uuid || '-')}</p>
      <p class="muted text-break">Fichier: ${escapeHtml(selected.filename || '-')}</p>
    `
    : emptyState('Sélectionnez un batch à gauche.');
}
