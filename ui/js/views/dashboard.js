import { apiGet } from '../api.js';
import { state } from '../state.js';
import { $, escapeHtml, formatDate, setToast } from '../utils.js';
import { pageHeader } from '../components/page-header.js';
import { healthCard } from '../components/health-card.js';
import { kpiCard } from '../components/kpi-card.js';
import { emptyState } from '../components/empty-state.js';
import { statusBadge } from '../components/status-chip.js';

export function renderDashboardView() {
  $('dashboardView').innerHTML = `
    ${pageHeader('Dashboard', 'Supervision opérationnelle des imports, suppressions et alertes.', '<div class="dashboard-header-actions"><span id="dashboardLastSync" class="muted">Dernière synchro: --</span><button id="dashboardRefresh" class="btn btn-secondary">↻</button></div>', 'dashboard-header')}
    <div class="grid-health" id="healthGrid"></div>
    <div class="grid-kpi" id="kpiGrid"></div>

    <div class="grid-main">
      <div class="card">
        <div class="section-header"><h3>Dernier import</h3></div>
        <div id="lastImportBlock"></div>
      </div>
      <div class="card">
        <div class="section-header"><h3>Alertes récentes</h3></div>
        <div id="alertsBlock"></div>
      </div>
    </div>

    <div class="grid-main">
      <div class="card">
        <div class="section-header"><h3>Activité récente</h3></div>
        <div id="activityBlock"></div>
      </div>
      <div class="card">
        <div class="section-header"><h3>Actions rapides</h3></div>
        <div id="quickActionsBlock" class="dashboard-quick-actions"></div>
      </div>
    </div>
  `;
  $('dashboardRefresh').addEventListener('click', refreshDashboard);
  $('quickActionsBlock').innerHTML = `
    <button class="btn btn-primary" data-target-view="importerView">Nouvel import</button>
    <button class="btn btn-secondary" data-target-view="historyView">Voir historique</button>
    <button class="btn btn-secondary" data-target-view="deletionsView">Prévisualiser suppression</button>
    <button class="btn btn-secondary" data-target-view="logsAuditView">Ouvrir logs</button>
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
      { label: 'API Import', ok: Boolean(health?.ok), detail: health?.resolved_container || 'Non détecté' },
      { label: 'Delete API', ok: Boolean(deleteCfg?.configured), detail: deleteCfg?.message || 'Configuration à vérifier' },
      { label: 'Base locale', ok: true, detail: `${dbSummary?.batches_count || 0} batch(es)` },
      { label: 'Passbolt / CLI', ok: Boolean(health?.resolved_cli_path), detail: health?.resolved_cli_path || 'Chemin inconnu' }
    ];
    $('healthGrid').innerHTML = healthCards.map(healthCard).join('');
    $('dashboardLastSync').textContent = `Dernière synchro: ${new Date().toLocaleTimeString('fr-FR')}`;

    const today = new Date().toDateString();
    const kpis = [
      ['Imports aujourd’hui', state.batches.filter((b) => new Date(b.created_at).toDateString() === today).length],
      ['Utilisateurs créés', latest?.success_count || 0],
      ['Groupes assignés', latest?.group_assignments || 0],
      ['Erreurs 24h', logsSummary?.by_level?.error || 0],
      ['Batches enregistrés', dbSummary?.batches_count || 0],
      ['Candidats supprimables', dbSummary?.deletable_candidates_count || 0]
    ];
    $('kpiGrid').innerHTML = kpis.map(([label, value]) => kpiCard(label, value)).join('');

    $('lastImportBlock').innerHTML = latest ? `
      <p class="dashboard-title text-ellipsis"><strong>${escapeHtml(latest.filename || '-')}</strong></p>
      <p class="muted text-ellipsis">${formatDate(latest.created_at)}</p>
      <p>${statusBadge(latest.status)}</p>
      <p class="muted text-break">Batch: ${escapeHtml(latest.batch_uuid || '-')}</p>
      <div class="dashboard-inline-kpis">
        <div><span class="muted">Créés</span><strong>${escapeHtml(latest.success_count || 0)}</strong></div>
        <div><span class="muted">Groupes</span><strong>${escapeHtml(latest.group_assignments || 0)}</strong></div>
        <div><span class="muted">Erreurs</span><strong>${escapeHtml(latest.error_count || 0)}</strong></div>
        <div><span class="muted">Supprimables</span><strong>${escapeHtml(latest.deletable_candidates || dbSummary?.deletable_candidates_count || 0)}</strong></div>
      </div>
      <div class="action-bar mt-3">
        <button class="btn btn-secondary" data-target-view="historyView">Voir le détail</button>
        <button class="btn btn-secondary" data-target-view="historyView">Historique</button>
      </div>
    ` : emptyState('Aucun import enregistré.');
    const alerts = [logsSummary?.by_level?.error ? `${logsSummary.by_level.error} erreur(s) critiques` : '', !deleteCfg?.configured ? 'Delete API non configurée' : '', !health?.ok ? 'API Import indisponible' : ''].filter(Boolean);
    $('alertsBlock').innerHTML = alerts.length ? `<p class="dashboard-alert-count">${alerts.length} alerte(s)</p>${alerts.map((a) => `<p class="line-clamp-2 text-break dashboard-alert-line">• ${escapeHtml(a)}</p>`).join('')}<div class="mt-3"><button class="btn btn-secondary" data-target-view="logsAuditView">Voir les logs</button></div>` : emptyState('Aucune alerte majeure.');
    $('activityBlock').innerHTML = state.batches.slice(0, 5).map((b) => `<div class="dashboard-activity-item"><p class="text-ellipsis"><strong>${escapeHtml(b.filename || 'Sans nom')}</strong></p><p class="muted text-ellipsis">Import ${escapeHtml((b.status || 'unknown').toLowerCase())} — ${formatDate(b.created_at)}</p></div>`).join('') || emptyState('Aucune activité récente.');
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
