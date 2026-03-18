import { apiGet } from '../api.js';
import { state } from '../state.js';
import { $, escapeHtml, formatDate, setToast } from '../utils.js';
import { emptyState } from '../components/empty-state.js';
import { statusBadge, statusChip } from '../components/status-chip.js';

function normalizeStatus(kind) {
  const map = {
    ok: { chip: 'operational', label: 'Opérationnel' },
    warning: { chip: 'degraded', label: 'Attention' },
    error: { chip: 'error', label: 'Erreur' },
    missing: { chip: 'error', label: 'Manquant' },
    partial: { chip: 'check', label: 'Partiel' },
    configured: { chip: 'check', label: 'Configuré' },
    unknown: { chip: 'unknown', label: 'Inconnu' }
  };
  return map[kind] || map.unknown;
}

function renderHealthCard(item) {
  const status = normalizeStatus(item?.status || 'unknown');
  return `<article class="health-card"><h3 class="text-ellipsis-wrap">${escapeHtml(item?.label || '-')}</h3><div>${statusChip(status.chip, status.label)}</div></article>`;
}

function shortRawMessage(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return '-';
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

function parseJsonSafely(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

async function fetchProbe(endpoint) {
  const checkedAt = new Date().toISOString();
  try {
    const res = await fetch(endpoint);
    const raw = await res.text();
    const payload = parseJsonSafely(raw);
    return { endpoint, status: res.status, raw, payload, checkedAt };
  } catch (error) {
    const raw = String(error?.message || error || 'unknown error');
    return { endpoint, status: 0, raw, payload: {}, checkedAt };
  }
}

function wasRecentImportSuccessful(latest) {
  if (!latest) return false;
  return Number(latest?.success_count || 0) > 0 || ['success', 'partial'].includes(String(latest?.status || '').toLowerCase());
}

function deriveApiImportStatus(probe, latestBatch) {
  const payload = probe?.payload || {};
  const statusCode = Number(probe?.status || 0);
  const healthy = statusCode === 200 && (payload?.ok === true || payload?.status === 'ok' || typeof payload?.docker === 'object' || Boolean(payload?.diagnostics));
  const recentImportOk = wasRecentImportSuccessful(latestBatch);
  const checkedAtLabel = probe?.checkedAt ? formatDate(probe.checkedAt) : '-';
  const baseDetail = `Endpoint: ${probe?.endpoint || '-'} | HTTP: ${statusCode || 'N/A'} | Vérif: ${checkedAtLabel} | Brut: ${shortRawMessage(probe?.raw)}`;

  if (healthy) return { status: 'configured', detail: baseDetail };
  if (recentImportOk) return { status: 'warning', detail: `${baseDetail} | Fallback: import récent réussi` };
  return { status: 'unknown', detail: `${baseDetail} | Backend import non détecté` };
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
    <div class="grid-main">
      <div class="card"><div class="section-header"><h3>Dernier import</h3></div><div id="lastImportBlock"></div></div>
      <div class="card"><div id="alertsBlock"></div></div>
    </div>
    <div class="card"><div class="section-header"><h3>Activité récente</h3></div><div id="activityBlock"></div></div>
  `;
}

export async function refreshDashboard() {
  try {
    const [healthProbe, deleteCfg, dbSummary, batches, logsSummary] = await Promise.all([
      fetchProbe('/api/health'),
      apiGet('/api/delete-config-status').catch(() => ({})),
      apiGet('/api/db/summary').catch(() => ({})),
      apiGet('/api/batches').catch(() => ({ items: [] })),
      apiGet('/api/logs/summary').catch(() => ({}))
    ]);
    const health = healthProbe?.payload || {};
    state.batches = batches?.items || [];
    const latest = dbSummary?.last_batch || state.batches[0];

    const apiImport = deriveApiImportStatus(healthProbe, latest);
    const cliStatus = deriveCliStatus(health);
    const apiHealth = deriveApiHealthStatus(deleteCfg);

    $('healthGrid').innerHTML = [
      { label: 'API Import', ...apiImport },
      { label: 'Création utilisateur via CLI', ...cliStatus },
      { label: 'Groupes / Suppression API', status: apiHealth.status },
      { label: 'Base locale', status: 'configured' },
      { label: 'Santé API globale', ...apiHealth }
    ].map(renderHealthCard).join('');

    $('lastImportBlock').innerHTML = latest ? `
      <p class="text-ellipsis"><strong>${escapeHtml(latest.filename || '-')}</strong></p>
      <p class="muted text-ellipsis">${formatDate(latest.created_at)}</p>
      <p class="mt-2">${statusBadge(latest.status)}</p>
      <div class="dashboard-inline-kpis">
        <div><span class="muted">Créés</span><strong>${escapeHtml(latest.success_count || 0)}</strong></div>
        <div><span class="muted">Groupes</span><strong>${escapeHtml(latest.group_assignments || 0)}</strong></div>
        <div><span class="muted">Erreurs</span><strong>${escapeHtml(latest.error_count || 0)}</strong></div>
        <div><span class="muted">Supprimables</span><strong>${escapeHtml(latest.deletable_candidates || dbSummary?.deletable_candidates_count || 0)}</strong></div>
      </div>
      <div class="action-bar mt-3"><button class="btn btn-secondary" data-target-view="historyView">Détails</button></div>
    ` : emptyState('Aucun import.');

    const importUnavailable = normalizeStatus(apiImport?.status || 'unknown').chip === 'unknown';
    const alerts = [
      logsSummary?.by_level?.error ? `${logsSummary.by_level.error} critique` : '',
      !deleteCfg?.configured ? 'Delete API non configurée' : '',
      importUnavailable ? 'API Import indisponible' : ''
    ].filter(Boolean);

    $('alertsBlock').innerHTML = alerts.length
      ? `${alerts.map((a) => `<p class="dashboard-alert-line">${escapeHtml(a)}</p>`).join('')}<div class="mt-3"><button class="btn btn-secondary" data-target-view="logsAuditView">Voir logs</button></div>`
      : emptyState('Aucune alerte.');

    $('activityBlock').innerHTML = state.batches.slice(0, 6).map((b) => `
      <div class="dashboard-activity-item">
        <p class="text-ellipsis"><strong>${escapeHtml(b.filename || 'Sans nom')}</strong></p>
        <p class="muted text-ellipsis">${formatDate(b.created_at)}</p>
      </div>
    `).join('') || emptyState('Aucune activité.');

    document.querySelectorAll('[data-target-view]').forEach((button) => {
      if (button.dataset.navBound) return;
      button.dataset.navBound = 'true';
      button.addEventListener('click', () => document.querySelector(`.menu-item[data-view="${button.dataset.targetView}"]`)?.click());
    });
  } catch (e) { setToast(`Dashboard indisponible: ${e.message}`, 'error'); }
}
