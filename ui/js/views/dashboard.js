import { apiGet } from '../api.js';
import { state } from '../state.js';
import { $, escapeHtml, formatDate, setToast } from '../utils.js';
import { emptyState } from '../components/empty-state.js';
import { statusBadge, statusChip } from '../components/status-chip.js';

function normalizeStatus(kind) {
  const map = {
    ok: { chip: 'operational', label: 'Opérationnel de bout en bout' },
    warning: { chip: 'degraded', label: 'Testé partiellement' },
    error: { chip: 'error', label: 'Validation échouée' },
    missing: { chip: 'error', label: 'Dépendance manquante' },
    partial: { chip: 'check', label: 'Configuré partiellement' },
    configured: { chip: 'check', label: 'Configuré' },
    unknown: { chip: 'unknown', label: 'Non détecté' }
  };
  return map[kind] || map.unknown;
}

function renderHealthCard(item) {
  const status = normalizeStatus(item?.status || 'unknown');
  return `<div class="health-card"><h3 class="text-ellipsis">${escapeHtml(item?.label || '-')}</h3><div>${statusChip(status.chip, status.label)}</div><p class="muted text-ellipsis">${escapeHtml(item?.detail || '-')}</p></div>`;
}

function deriveApiImportStatus(health) {
  if (!health?.ok) return { status: 'unknown', detail: 'Backend import non détecté' };
  return { status: 'configured', detail: 'Configuration import détectée' };
}

function deriveCliStatus(health) {
  if (health?.docker?.cli_path_found) return { status: 'configured', detail: health?.cli_path || 'CLI détectée' };
  return { status: 'missing', detail: health?.cli_path || 'CLI non détectée' };
}

function deriveApiHealthStatus(deleteCfg) {
  const s = deleteCfg?.overall_status || 'unknown';
  if (s === 'ok') return { status: 'ok', detail: 'JWT/MFA/Groupes validés' };
  if (s === 'warning') return { status: 'warning', detail: deleteCfg?.message || 'Diagnostic incomplet' };
  if (s === 'error') return { status: 'error', detail: deleteCfg?.message || 'Échec diagnostic API' };
  return { status: 'unknown', detail: 'Diagnostic requis' };
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
    </div>
  `;
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

    const apiImport = deriveApiImportStatus(health);
    const cliStatus = deriveCliStatus(health);
    const apiHealth = deriveApiHealthStatus(deleteCfg);

    const jwtRejected = deleteCfg?.jwt_login_status === 'error';
    const deleteApiDetail = jwtRejected
      ? (deleteCfg?.message || 'Crypto locale OK / Login JWT rejeté par Passbolt')
      : (deleteCfg?.groups_status ? `Groupes: ${deleteCfg.groups_status}` : (deleteCfg?.message || 'Diagnostic requis'));

    const healthCards = [
      { label: 'API Import', ...apiImport },
      { label: 'Création utilisateur via CLI', ...cliStatus },
      { label: 'Groupes / Suppression API', status: apiHealth.status, detail: deleteApiDetail },
      { label: 'Base locale', status: 'configured', detail: `${dbSummary?.batches_count || 0} batch` },
      { label: 'Santé API globale', ...apiHealth }
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
