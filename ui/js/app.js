import { state, setTheme } from './state.js';
import { $, setToast } from './utils.js';
import { renderDashboardView, refreshDashboard } from './views/dashboard.js';
import { renderImporterView } from './views/importer.js';
import { renderDeletionsView, refreshDeleteConfig } from './views/deletions.js';
import { renderHistoryView, refreshHistory } from './views/history.js';
import { renderLogsView, refreshLogs } from './views/logs.js';

const refreshByView = {
  dashboardView: refreshDashboard,
  deletionsView: refreshDeleteConfig,
  historyView: refreshHistory,
  logsAuditView: refreshLogs
};

function switchView(viewId) {
  state.view = viewId;
  document.querySelectorAll('.menu-item').forEach((a) => a.classList.toggle('active', a.dataset.view === viewId));
  document.querySelectorAll('.view-section').forEach((v) => v.classList.toggle('active-view', v.id === viewId));
  refreshByView[viewId]?.();
}

function initThemeToggle() {
  const toggle = $('themeToggle');
  if (!toggle) return;
  const updateLabel = () => {
    toggle.textContent = state.theme === 'light' ? 'Mode sombre' : 'Mode clair';
  };
  updateLabel();
  toggle.addEventListener('click', () => {
    const next = state.theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    updateLabel();
  });
}

function renderLayout() {
  renderDashboardView();
  renderImporterView();
  renderDeletionsView();
  renderHistoryView();
  renderLogsView();
}

function init() {
  renderLayout();
  initThemeToggle();
  document.querySelectorAll('.menu-item').forEach((item) => item.addEventListener('click', (e) => {
    e.preventDefault();
    switchView(item.dataset.view);
  }));
  Promise.all([refreshDashboard(), refreshDeleteConfig(), refreshHistory(), refreshLogs()]).catch((e) => setToast(e.message));
}

init();
