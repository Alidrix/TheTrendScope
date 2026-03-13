export const state = {
  view: 'dashboardView',
  activeBatch: null,
  batches: [],
  latestImportResults: [],
  deletePreviewDone: false,
  logsTab: 'summaryTab',
  historySearch: '',
  historySort: 'date_desc'
};

export const STAGES = ['preview', 'create-user', 'create-group', 'assign-group', 'done'];
