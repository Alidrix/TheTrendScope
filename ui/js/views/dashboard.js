import { apiGet } from '../api.js';
import { state } from '../state.js';
import { $, escapeHtml, formatDate, setToast } from '../utils.js';
import { emptyState } from '../components/empty-state.js';
import { statusBadge, statusChip } from '../components/status-chip.js';

function renderHealthCard(item) {
  const ok = Boolean(item?.ok);
  return `<div class="health-card"><h3 class="text-ellipsis">${escapeHtml(item?.label || '-')}</h3><div>${ok ? statusChip('operational', 'Opérationnel') : statusChip('check', 'À vérifier')}</div><p class="muted text-ellipsis">${escapeHtml(item?.detail || '-')}</p></div>`;
}

export function renderDashboardView() {
  $('dashboardView').innerHTML = `
    <div class="grid-health" id="healthGrid"></div>

    <div class="grid-main compact-main">
      <div class="card">
        <div class="section-header"><h3>Dernier import</h3></div>
        <div id="lastImportBlock"></div>
      </div>
      <div class="card">
        <div class="section-header"><h3>Alertes</h3></div>
        <div id="alertsBlock"></div>
      </div>
    </div>

    <div class="grid-main compact-main">
      <div class="card">
        <div class="section-header"><h3>Activité</h3></div>
        <div id="activityBlock"></div>
      </div>
      <div class="card">
        <div class="section-header"><h3>Actions</h3></div>
        <div id="quickActionsBlock" class="dashboard-quick-actions"></div>
      </div>
    </div>
  `;
  $('quickActionsBlock').innerHTML = `
    <button class="btn btn-primary" data-target-view="importerView">Nouvel import</button>
    <button class="btn btn-secondary" data-target-view="historyView">Historique</button>
    <button class="btn btn-secondary" data-target-view="deletionsView">Prévisualiser</button>
    <button class="btn btn-secondary" data-target-view="logsAuditView">Logs</button>
  `;
  document.querySelectorAll('[data-target-view]').forEach((button) => {
    button.addEventListener('click', () => {
      const view = button.dataset.targetView;
      const nav = document.querySelector(`.menu-item[data-view="${view}"]`);
      nav?.click();
    });
  });
}

export async function refreshDashboard() {
  try {
    const [health, deleteCfg, dbSummary, batches, logsSummary] = await Promise.all([
      apiGet('/api/health').catch(() => ({})),
      apiGet('/api/delete-config-status').catch(() => ({})),
      apiGet('/api/db/summary').catch(() => ({})),
      apiGet('/api/batches').catch(() => ({ items: [] })),
      apiGet('/api/logs/summary').catch(() => ({}))
    ]);
    state.batches = batches?.items || [];
    const latest = dbSummary?.last_batch || state.batches[0];
    const healthCards = [
      { label: 'API Import', ok: Boolean(health?.ok), detail: health?.ok ? 'Configurée' : 'Non détectée' },
      { label: 'Delete API', ok: Boolean(deleteCfg?.configured), detail: deleteCfg?.configured ? 'Configurée' : 'Non détectée' },
      { label: 'Base locale', ok: true, detail: `${dbSummary?.batches_count || 0} batch` },
      { label: 'Passbolt / CLI', ok: Boolean(health?.resolved_cli_path), detail: health?.resolved_cli_path || 'Chemin inconnu' }
    ];
    $('healthGrid').innerHTML = healthCards.map((item) => renderHealthCard(item)).join('');

    $('lastImportBlock').innerHTML = latest ? `
      <p class="dashboard-title text-ellipsis"><strong>${escapeHtml(latest.filename || '-')}</strong></p>
      <p class="muted text-ellipsis">${formatDate(latest.created_at)}</p>
      <p>${statusBadge(latest.status)}</p>
      <p class="muted text-ellipsis">${escapeHtml(latest.batch_uuid || '-')}</p>
      <div class="dashboard-inline-kpis">
        <div><span class="muted">Créés</span><strong>${escapeHtml(latest.success_count || 0)}</strong></div>
        <div><span class="muted">Groupes</span><strong>${escapeHtml(latest.group_assignments || 0)}</strong></div>
        <div><span class="muted">Erreurs</span><strong>${escapeHtml(latest.error_count || 0)}</strong></div>
        <div><span class="muted">Supprimables</span><strong>${escapeHtml(latest.deletable_candidates || dbSummary?.deletable_candidates_count || 0)}</strong></div>
      </div>
      <div class="action-bar mt-3">
        <button class="btn btn-secondary" data-target-view="historyView">Détails</button>
      </div>
    ` : emptyState('Aucun import.');
    const alerts = [logsSummary?.by_level?.error ? `${logsSummary.by_level.error} critique` : '', !deleteCfg?.configured ? 'Delete API non configurée' : '', !health?.ok ? 'API Import indisponible' : ''].filter(Boolean);
    $('alertsBlock').innerHTML = alerts.length ? `${alerts.map((a) => `<p class="line-clamp-2 text-break dashboard-alert-line">${escapeHtml(a)}</p>`).join('')}<div class="mt-3"><button class="btn btn-secondary" data-target-view="logsAuditView">Voir logs</button></div>` : emptyState('Aucune alerte.');
    $('activityBlock').innerHTML = state.batches.slice(0, 5).map((b) => `<div class="dashboard-activity-item"><p class="text-ellipsis"><strong>${escapeHtml(b.filename || 'Sans nom')}</strong></p><p class="muted text-ellipsis">${formatDate(b.created_at)}</p></div>`).join('') || emptyState('Aucune activité.');
    document.querySelectorAll('[data-target-view]').forEach((button) => {
      if (button.dataset.navBound) return;
      button.dataset.navBound = 'true';
      button.addEventListener('click', () => {
        const view = button.dataset.targetView;
        const nav = document.querySelector(`.menu-item[data-view="${view}"]`);
        nav?.click();
      });
    });
  } catch (e) { setToast(`Dashboard indisponible: ${e.message}`); }
}
