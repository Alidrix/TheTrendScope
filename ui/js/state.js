export const state = {
  view: 'dashboardView',
  activeBatch: null,
  batches: [],
  latestImportResults: [],
  deletePreviewDone: false,
  logsTab: 'summaryTab',
  historySearch: '',
  historySort: 'date_desc',
  theme: localStorage.getItem('tts-theme') || 'dark'
};

export const STAGES = ['preview', 'create-user', 'create-group', 'assign-group', 'done'];

export function setTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('tts-theme', theme);
}

setTheme(state.theme);
