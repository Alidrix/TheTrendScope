const DEFAULT_SUPABASE_URL = 'https://ltxjjnzsphhprykuwwye.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0eGpqbnpzcGhocHJ5a3V3d3llIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ3ODgyMDYsImV4cCI6MjA4MDM2NDIwNn0.AR4MHCGyhBDpX3BTBIqQh0qap6tOLUHfuP8HMofF3Sk';
const ALERT_THRESHOLD = 500_000;
const BASE_CATEGORIES = ['nourriture', 'voiture', 'business', 'drôle', 'influenceurs', 'gaming', 'sport', 'musique'];

function resolveSupabaseClient() {
  const url = window.SUPABASE_URL || (typeof SUPABASE_URL !== 'undefined' ? SUPABASE_URL : '') || DEFAULT_SUPABASE_URL;
  const key =
    window.SUPABASE_ANON_KEY || (typeof SUPABASE_ANON_KEY !== 'undefined' ? SUPABASE_ANON_KEY : '') || DEFAULT_SUPABASE_ANON_KEY;

  window.SUPABASE_URL = url;
  window.SUPABASE_ANON_KEY = key;

  if (window.supabaseClient) return window.supabaseClient;
  if (window.supabase && window.supabase.createClient && url && key) {
    window.supabaseClient = window.supabase.createClient(url, key);
    return window.supabaseClient;
  }
  return null;
}


function resolveSupabaseClient() {
  const url = window.SUPABASE_URL || (typeof SUPABASE_URL !== 'undefined' ? SUPABASE_URL : '') || DEFAULT_SUPABASE_URL;
  const key =
    window.SUPABASE_ANON_KEY || (typeof SUPABASE_ANON_KEY !== 'undefined' ? SUPABASE_ANON_KEY : '') || DEFAULT_SUPABASE_ANON_KEY;

function resolveSupabaseClient() {
  const url =
    window.SUPABASE_URL ||
    (typeof SUPABASE_URL !== 'undefined' ? SUPABASE_URL : '') ||
    DEFAULT_SUPABASE_URL;
  const key =
    window.SUPABASE_ANON_KEY ||
    (typeof SUPABASE_ANON_KEY !== 'undefined' ? SUPABASE_ANON_KEY : '') ||
    DEFAULT_SUPABASE_ANON_KEY;

  window.SUPABASE_URL = url;
  window.SUPABASE_ANON_KEY = key;

  if (window.supabaseClient) return window.supabaseClient;
  if (window.supabase && window.supabase.createClient && url && key) {
    window.supabaseClient = window.supabase.createClient(url, key);
    return window.supabaseClient;
  }
  return null;
}

const supabase = resolveSupabaseClient();
const { createClient } = window.supabase || {};
const supabase =
  window.supabaseClient ||
  (createClient && window.SUPABASE_URL && window.SUPABASE_ANON_KEY
    ? createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY)
    : null);
const LOCAL_SESSION_KEY = 'trendscope.local.session';

  window.SUPABASE_URL = url;
  window.SUPABASE_ANON_KEY = key;

  if (window.supabaseClient) return window.supabaseClient;
  if (window.supabase && window.supabase.createClient && url && key) {
    window.supabaseClient = window.supabase.createClient(url, key);
    return window.supabaseClient;
  }
  return null;
}

const supabase = resolveSupabaseClient();
const state = {
  videos: [],
  history: [],
  notes: {},
  stats: {},
  notifications: [],
  loading: false,
};

const elements = {
  grid: document.getElementById('video-grid'),
  historyList: document.getElementById('history-list'),
  categorySelect: document.getElementById('filter-category'),
  regionSelect: document.getElementById('filter-region'),
  languageSelect: document.getElementById('filter-language'),
  searchBtn: document.getElementById('search-btn'),
  refreshBtn: document.getElementById('refresh-btn'),
  refreshStatsBtn: document.getElementById('refresh-stats-btn'),
  toastContainer: document.querySelector('.toast-container'),
  notificationList: document.querySelector('.notifications'),
  pageLoader: document.querySelector('.page-loader'),
  previewModal: document.getElementById('preview-modal'),
  previewFrame: document.getElementById('preview-frame'),
  previewTitle: document.getElementById('preview-title'),
  previewClose: document.getElementById('preview-close'),
};

function formatNumber(value) {
  if (value === undefined || value === null || Number.isNaN(value)) return '—';
  return Number(value).toLocaleString();
}

function formatDelta(current, previous = 0) {
  const delta = current - previous;
  const direction = delta >= 0 ? '▲' : '▼';
  return `${direction} ${formatNumber(Math.abs(delta))}`;
}

function formatTime(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  if (Number.isNaN(date)) return '';
  return date.toLocaleString();
}

function addNotification(message, type = 'info') {
  if (!elements.notificationList) return;
  const item = document.createElement('div');
  item.className = `notification ${type}`;
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  item.innerHTML = `<span class="message">${message}</span><span class="time">${time}</span>`;
  elements.notificationList.prepend(item);
  while (elements.notificationList.children.length > 10) {
    elements.notificationList.lastChild.remove();
  }
}

function showToast(message, type = 'info') {
  if (!elements.toastContainer || !message) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  elements.toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), 4200);
  addNotification(message, type);
}

function setButtonBusy(btn, busy, label) {
  if (!btn) return;
  btn.disabled = busy;
  btn.innerHTML = busy
    ? `<span class="loader"><span class="dot"></span><span class="dot"></span><span class="dot"></span> ${label}</span>`
    : label;
}

function toggleLoader(active) {
  if (!elements.pageLoader) return;
  elements.pageLoader.classList.toggle('active', active);
}

function normalizeVideo(video, fallbackIndex = 0) {
  const youtubeId = video.youtube_id || video.youtubeId || video.id || `video-${fallbackIndex}`;
  const videoUrl = video.video_url || (youtubeId ? `https://www.youtube.com/watch?v=${youtubeId}` : '#');
  return {
    id: video.id || youtubeId,
    youtube_id: youtubeId,
    title: video.title || 'Vidéo sans titre',
    channel: video.channel_title || video.channel || 'Chaîne inconnue',
    thumbnail_url: video.thumbnail_url || video.thumbnailUrl || 'images/bg.jpg',
    region: video.region || 'Global',
    category: video.category || '',
    language: video.language || '',
    is_short: Boolean(video.is_short),
    status: video.status || 'active',
    used_at: video.used_at || null,
    views: Number(video.views || 0),
    likes: Number(video.likes || 0),
    views_per_hour: Number(video.views_per_hour || 0),
    published_at: video.published_at || video.collected_at || null,
    collected_at: video.collected_at || null,
    video_url: videoUrl,
  };
}

function currentFilters() {
  return {
    category: elements.categorySelect?.value || 'all',
    region: elements.regionSelect?.value || 'all',
    language: elements.languageSelect?.value || 'all',
  };
}

async function fetchVideos(filters = currentFilters()) {
  if (!supabase) return fallbackVideos();
  let query = supabase
async function fetchVideos() {
  if (!supabase) return fallbackVideos();
  const { data, error } = await supabase
    .from('video_feed')
    .select(
      'id,youtube_id,title,channel_title,thumbnail_url,region,category,language,is_short,status,used_at,views,likes,views_per_hour,published_at,collected_at'
    )
    .order('status', { ascending: true })
    .order('collected_at', { ascending: false, nullsLast: true });

  if (filters.category && filters.category !== 'all') {
    query = query.eq('category', filters.category);
  }
  if (filters.region && filters.region !== 'all') {
    query = query.eq('region', filters.region);
  }
  if (filters.language && filters.language !== 'all') {
    query = query.eq('language', filters.language);
  }

  const { data, error } = await query;
  if (error) {
    showToast(`Erreur Supabase: ${error.message}`, 'error');
    return fallbackVideos();
  }
  return (data || []).map(normalizeVideo);
}

async function fetchNotes(videoIds = []) {
  if (!supabase || !videoIds.length) return {};
  const { data, error } = await supabase
    .from('notes')
    .select('video_id, body, updated_at')
    .in('video_id', videoIds);
  if (error) {
    showToast(`Notes: ${error.message}`, 'error');
    return {};
  }
  return (data || []).reduce((acc, row) => {
    acc[row.video_id] = row;
    return acc;
  }, {});
}

async function markAsUsed(video) {
  if (!supabase) {
    showToast('Supabase non configuré', 'warning');
    return;
  }
  return (data || []).reduce((acc, row) => {
    acc[row.video_id] = row;
    return acc;
  }, {});
}

async function markAsUsed(video) {
  if (!supabase) {
    showToast('Supabase non configuré', 'warning');
    return;
async function fetchVideos() {
  if (!supabase) {
    notify('Supabase credentials missing. Add SUPABASE_URL and SUPABASE_ANON_KEY.', 'warning');
    return [];
  }
  const { data, error } = await supabase
    .from('video_feed')
    .select('id, youtube_id, title, channel_title, thumbnail_url, views, views_per_hour, published_at, collected_at')
    .order('collected_at', { ascending: false, nullsLast: true })
    .order('views_per_hour', { ascending: false, nullsLast: true });
  if (error) {
    notify(`Error fetching videos: ${error.message}`, 'error');
    throw error;
  }
  return data?.map(normalizeVideoForDashboard) || [];
}

function renderFilters() {
  const categories = new Set();
  const regions = new Set();
  const languages = new Set();

  state.videos.forEach(({ category, region, language }) => {
    if (category) categories.add(category);
    if (region) regions.add(region);
    if (language) languages.add(language);
  });

  buildOptions(elements.categorySelect, categories);
  buildOptions(elements.regionSelect, regions);
  buildOptions(elements.languageSelect, languages);
}

function buildOptions(select, values) {
  if (!select) return;
  const current = select.value;
  select.innerHTML =
    '<option value="all">All</option>' +
    Array.from(values)
      .sort()
      .map((value) => `<option value="${value}">${value}</option>`)
      .join('');
  if (Array.from(values).includes(current)) {
    select.value = current;
  }
  const { error } = await supabase
    .from('videos')
    .update({ status: 'used', used_at: new Date().toISOString() })
    .eq('id', video.id);
  if (error) {
    showToast(`Impossible de marquer: ${error.message}`, 'error');
    return;
  }
  showToast('Vidéo déplacée en historique.', 'success');
  state.history.unshift({ ...video, status: 'used', used_at: new Date().toISOString() });
  state.videos = state.videos.filter((v) => v.id !== video.id);
  render();
}

async function saveNote(videoId, existingBody = '') {
  const content = prompt('Note personnelle', existingBody || '');
  if (content === null) return;
  if (!supabase) {
    showToast('Supabase non configuré', 'warning');
    return;
  }
  const payload = { video_id: videoId, body: content, updated_at: new Date().toISOString() };
  const { data, error } = await supabase.from('notes').upsert(payload, { onConflict: 'video_id' }).select();
  if (error) {
    showToast(`Note non sauvegardée: ${error.message}`, 'error');
    return;
  }
  state.notes[videoId] = data?.[0] || payload;
  showToast('Note sauvegardée.', 'success');
  render();
}

function fallbackVideos() {
  return [
    {
      id: 'fallback-1',
      youtube_id: 'H2x5Lw',
      title: 'AI trailer rewrites break the internet',
      channel: 'Creator Lab',
      thumbnail_url: 'https://images.unsplash.com/photo-1498050108023-c5249f4df085?auto=format&fit=crop&w=900&q=60',
      views: 9820000,
      likes: 120000,
      views_per_hour: 742000,
      published_at: '2024-08-16T13:00:00Z',
      category: 'business',
      language: 'en',
      region: 'US',
      is_short: false,
      status: 'active',
    },
    {
      id: 'fallback-2',
      youtube_id: 't9M2vb',
      title: '24h speedrun of the world’s hardest puzzle',
      channel: 'Puzzle Forge',
      thumbnail_url: 'https://images.unsplash.com/photo-1522199710521-72d69614c702?auto=format&fit=crop&w=900&q=60',
      views: 4512000,
      likes: 89000,
      views_per_hour: 529000,
      published_at: '2024-08-16T09:15:00Z',
      category: 'gaming',
      language: 'en',
      region: 'US',
      is_short: true,
      status: 'active',
    },
    {
      id: 'fallback-3',
      youtube_id: 'kX2jQz',
      title: 'Live: breaking tech earnings',
      channel: 'MarketStream',
      thumbnail_url: 'https://images.unsplash.com/photo-1556761175-5973dc0f32e7?auto=format&fit=crop&w=900&q=60',
      views: 1210000,
      likes: 24000,
      views_per_hour: 312000,
      published_at: '2024-08-16T08:00:00Z',
      category: 'business',
      language: 'en',
      region: 'Global',
      is_short: false,
      status: 'active',
    },
  ].map(normalizeVideo);
}

function buildCard(video, note) {
  const deltaViews = formatDelta(video.views, 0);
  const alertBadge = video.views_per_hour >= ALERT_THRESHOLD ? '<span class="badge short">🚀 Viral</span>' : '';
  const noteLabel = note?.body ? 'Modifier la note' : 'Ajouter une note';
  return `
    <article class="card" data-id="${video.id}">
      <div class="thumb">
        <img src="${video.thumbnail_url}" alt="${video.title}" />
        <div class="badges">
          ${video.is_short ? '<span class="badge short">Short</span>' : ''}
          ${video.language ? `<span class="badge language">${video.language}</span>` : ''}
          ${video.region ? `<span class="badge region">${video.region}</span>` : ''}
          ${video.category ? `<span class="badge category">${video.category}</span>` : ''}
          ${alertBadge}
        </div>
}

function buildCard(video, note) {
  const deltaViews = formatDelta(video.views, 0);
  const alertBadge = video.views_per_hour >= ALERT_THRESHOLD ? '<span class="badge short">🚀 Viral</span>' : '';
  const noteLabel = note?.body ? 'Modifier la note' : 'Ajouter une note';
  return `
    <article class="card" data-id="${video.id}">
      <div class="thumb">
        <img src="${video.thumbnail_url}" alt="${video.title}" />
        <div class="badges">
          ${video.is_short ? '<span class="badge short">Short</span>' : ''}
          ${video.language ? `<span class="badge language">${video.language}</span>` : ''}
          ${video.region ? `<span class="badge region">${video.region}</span>` : ''}
          ${video.category ? `<span class="badge category">${video.category}</span>` : ''}
          ${alertBadge}
        </div>
  const html = filtered
    .map((video) => buildCard(video, state.stats[video.id], state.notes[video.id]))
    .join('');
  elements.grid.innerHTML = html;
}

function buildCard(video, stat = {}, note = {}) {
  const delta = (stat.current_views || video.views || 0) - (stat.initial_views || video.views || 0);
  const deltaClass = delta >= 0 ? 'trend-up' : 'trend-down';
  const deltaLabel = delta >= 0 ? '▲' : '▼';
  const videoUrl = video.video_url || (video.youtube_id ? `https://www.youtube.com/watch?v=${video.youtube_id}` : '#');
  return `
    <article class="card" data-id="${video.id}">
      <div class="thumb">
        <a href="${videoUrl}" target="_blank" rel="noopener noreferrer">
          <img src="${video.thumbnail_url || 'images/bg.jpg'}" alt="${video.title}">
        </a>
        <div class="badges"></div>
      </div>
      <div class="content">
        <h3 class="title">${video.title}</h3>
        <div class="meta">${video.channel} · ${formatTime(video.published_at)}</div>
        <div class="stats">
          <div class="stat"><span class="label">Vues</span><span class="value">${formatNumber(video.views)}</span></div>
          <div class="stat"><span class="label">Likes</span><span class="value">${formatNumber(video.likes)}</span></div>
          <div class="stat"><span class="label">Δ vues</span><span class="value trend-up">${deltaViews}</span></div>
          <div class="stat"><span class="label">Vélocité</span><span class="value">${formatNumber(video.views_per_hour)} /h</span></div>
        </div>
        <div class="actions-row actions-inline">
          <button class="btn secondary preview-btn" data-id="${video.id}" data-youtube="${video.youtube_id}"><i class="fa fa-play"></i> Prévisualiser</button>
          <button class="btn ghost mark-used-btn" data-id="${video.id}"><i class="fa fa-archive"></i> Marquer utilisée</button>
          <button class="btn ghost note-btn" data-id="${video.id}"><i class="fa fa-sticky-note"></i> ${noteLabel}</button>
          <a class="btn secondary" href="${video.video_url}" target="_blank" rel="noopener noreferrer"><i class="fa fa-external-link-alt"></i> Ouvrir sur YouTube</a>
        </div>
        <div class="actions-row actions-inline">
          <button class="btn secondary preview-btn" data-id="${video.id}" data-youtube="${video.youtube_id}"><i class="fa fa-play"></i> Prévisualiser</button>
          <button class="btn ghost mark-used-btn" data-id="${video.id}"><i class="fa fa-archive"></i> Marquer utilisée</button>
          <button class="btn ghost note-btn" data-id="${video.id}"><i class="fa fa-sticky-note"></i> ${noteLabel}</button>
          <a class="btn secondary" href="${video.video_url}" target="_blank" rel="noopener noreferrer"><i class="fa fa-external-link-alt"></i> Ouvrir sur YouTube</a>
          <div class="stat">
            <span class="label">Initial views</span>
            <span class="value">${formatNumber(stat.initial_views || video.views)}</span>
          </div>
          <div class="stat">
            <span class="label">Current views</span>
            <span class="value">${formatNumber(stat.current_views || video.views)}</span>
          </div>
          <div class="stat">
            <span class="label">Δ views</span>
            <span class="value ${deltaClass}">${deltaLabel} ${formatNumber(Math.abs(delta))}</span>
          </div>
          <div class="stat">
            <span class="label">Views / hour</span>
            <span class="value">${formatNumber(stat.views_per_hour || video.views_per_hour)}</span>
          </div>
        </div>
        <div class="actions-row actions-inline">
          <a class="btn secondary" href="${videoUrl}" target="_blank" rel="noopener noreferrer">Open on YouTube</a>
        </div>
      </div>
    </article>
  `;
}

function buildHistoryItem(video) {
  return `
    <div class="notification info">
      <span class="message">${video.title} • ${formatNumber(video.views)} vues</span>
      <span class="time">${video.used_at ? formatTime(video.used_at) : 'historique'}</span>
    </div>
  `;
}

function renderFilters() {
  const categories = new Set(BASE_CATEGORIES);
  state.videos.concat(state.history).forEach((v) => v.category && categories.add(v.category));
  if (elements.categorySelect) {
    const current = elements.categorySelect.value;
    elements.categorySelect.innerHTML = '<option value="all">Toutes</option>' +
      Array.from(categories).map((c) => `<option value="${c}">${c}</option>`).join('');
    if (categories.has(current)) elements.categorySelect.value = current;
  }
}

function applyFilters(video) {
  const category = elements.categorySelect?.value || 'all';
  const region = elements.regionSelect?.value || 'all';
  const language = elements.languageSelect?.value || 'all';
  const matchesCategory = category === 'all' || video.category === category;
  const matchesRegion = region === 'all' || video.region === region;
  const matchesLanguage = language === 'all' || video.language === language;
  return matchesCategory && matchesRegion && matchesLanguage;
}

function renderGrid() {
  if (!elements.grid) return;
  const filtered = state.videos.filter(applyFilters);
  if (!filtered.length) {
    elements.grid.innerHTML = '<div class="empty">Aucune vidéo active ne correspond aux filtres.</div>';
    return;
function notify(message, type = 'info') {
  if (elements.toastContainer) {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    elements.toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
  }
  elements.grid.innerHTML = filtered.map((video) => buildCard(video, state.notes[video.id])).join('');
}

function renderHistory() {
  if (!elements.historyList) return;
  if (!state.history.length) {
    elements.historyList.innerHTML = '<div class="notification info"><span class="message">Historique vide.</span><span class="time"></span></div>';
    return;
  }
  elements.historyList.innerHTML = state.history.map(buildHistoryItem).join('');
}

function render() {
  renderFilters();
  renderGrid();
  renderHistory();
}

async function loadData({ skipRefreshApi = false } = {}) {
  try {
    state.loading = true;
    toggleLoader(true);
    setButtonBusy(elements.refreshBtn, true, 'Rafraîchir…');
    setButtonBusy(elements.searchBtn, true, 'Rechercher…');
    if (elements.refreshStatsBtn) setButtonBusy(elements.refreshStatsBtn, true, 'Stats…');

    if (!skipRefreshApi) {
      try {
        await fetch('/api/refresh', { method: 'POST' });
      } catch (e) {
        console.warn('Refresh trigger failed (non bloquant):', e);
      }
    }

    const videos = await fetchVideos();
    const notes = await fetchNotes(videos.map((v) => v.id));

    state.notes = notes;
    state.videos = videos.filter((v) => v.status !== 'used');
    state.history = videos.filter((v) => v.status === 'used');

    const alerts = state.videos.filter((v) => v.views_per_hour >= ALERT_THRESHOLD);
    alerts.forEach((alert) => showToast(`🚀 ${alert.title} dépasse ${formatNumber(ALERT_THRESHOLD)} vues/h`, 'info'));

    state.videos = videos;
    state.stats = videos.reduce((acc, video) => {
      acc[video.id] = {
        initial_views: video.views,
        current_views: video.views,
        views_per_hour: video.views_per_hour,
      };
      return acc;
    }, {});
    state.notes = {};

    const alerts = state.videos.filter((v) => v.views_per_hour >= ALERT_THRESHOLD);
    alerts.forEach((alert) => showToast(`🚀 ${alert.title} dépasse ${formatNumber(ALERT_THRESHOLD)} vues/h`, 'info'));

    render();
  } catch (error) {
    console.error(error);
    showToast(error.message || 'Chargement impossible', 'error');
  } finally {
    state.loading = false;
    toggleLoader(false);
    setButtonBusy(elements.refreshBtn, false, '<i class="fa fa-refresh"></i> Rafraîchir');
    setButtonBusy(elements.searchBtn, false, '<i class="fa fa-search"></i> Rechercher');
    if (elements.refreshStatsBtn) setButtonBusy(elements.refreshStatsBtn, false, '<i class="fa fa-chart-line"></i> Rafraîchir les stats');
  }
}

function handleCardActions(event) {
  const target = event.target.closest('button, a');
  if (!target) return;
  const card = target.closest('.card');
  const videoId = target.dataset.id || card?.dataset.id;
  const video = state.videos.find((v) => v.id === videoId) || state.history.find((v) => v.id === videoId);
  if (!video) return;

  if (target.classList.contains('preview-btn')) {
    openPreview(video);
  } else if (target.classList.contains('mark-used-btn')) {
    markAsUsed(video);
  } else if (target.classList.contains('note-btn')) {
    saveNote(video.id, state.notes[video.id]?.body);
  }
}

function openPreview(video) {
  if (!elements.previewModal || !elements.previewFrame) return;
  const embedUrl = `https://www.youtube.com/embed/${video.youtube_id}`;
  elements.previewFrame.src = embedUrl;
  if (elements.previewTitle) elements.previewTitle.textContent = video.title;
  elements.previewModal.style.display = 'flex';
}

function closePreview() {
  if (!elements.previewModal) return;
  elements.previewModal.style.display = 'none';
  if (elements.previewFrame) elements.previewFrame.src = '';
}

function bindEvents() {
  elements.grid?.addEventListener('click', handleCardActions);
  elements.refreshBtn?.addEventListener('click', () => loadData());
  elements.searchBtn?.addEventListener('click', () => loadData({ skipRefreshApi: true }));
  elements.refreshStatsBtn?.addEventListener('click', () => loadData({ skipRefreshApi: true }));
  elements.categorySelect?.addEventListener('change', renderGrid);
  elements.regionSelect?.addEventListener('change', renderGrid);
  elements.languageSelect?.addEventListener('change', renderGrid);
  elements.previewClose?.addEventListener('click', closePreview);
  elements.previewModal?.addEventListener('click', (event) => {
    if (event.target === elements.previewModal) closePreview();
  });
}

window.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  loadData();

  if (target.classList.contains('preview-btn')) {
    openPreview(video);
  } else if (target.classList.contains('mark-used-btn')) {
    markAsUsed(video);
  } else if (target.classList.contains('note-btn')) {
    saveNote(video.id, state.notes[video.id]?.body);
  }
}

function openPreview(video) {
  if (!elements.previewModal || !elements.previewFrame) return;
  const embedUrl = `https://www.youtube.com/embed/${video.youtube_id}`;
  elements.previewFrame.src = embedUrl;
  if (elements.previewTitle) elements.previewTitle.textContent = video.title;
  elements.previewModal.style.display = 'flex';
}

function closePreview() {
  if (!elements.previewModal) return;
  elements.previewModal.style.display = 'none';
  if (elements.previewFrame) elements.previewFrame.src = '';
}

function bindEvents() {
  elements.grid?.addEventListener('click', handleCardActions);
  elements.refreshBtn?.addEventListener('click', () => loadData());
  elements.refreshStatsBtn?.addEventListener('click', () => loadData({ skipRefreshApi: true }));
  elements.categorySelect?.addEventListener('change', renderGrid);
  elements.regionSelect?.addEventListener('change', renderGrid);
  elements.languageSelect?.addEventListener('change', renderGrid);
  elements.previewClose?.addEventListener('click', closePreview);
  elements.previewModal?.addEventListener('click', (event) => {
    if (event.target === elements.previewModal) closePreview();
  });
}

window.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  loadData();
function normalizeVideoForDashboard(video) {
  return {
    ...video,
    creator: video.channel_title || video.channel || 'Unknown creator',
    thumbnail_url: video.thumbnail_url,
    region: video.region || '',
    category: video.category || '',
    language: video.language || '',
    video_url: video.youtube_id ? `https://www.youtube.com/watch?v=${video.youtube_id}` : video.url,
  };
}

async function requireSession() {
  try {
    if (localStorage.getItem(LOCAL_SESSION_KEY)) return true;
  } catch (e) {
    console.warn('Unable to read local session', e);
  }
  const client = resolveSupabaseClient();
  if (!client) return false;
  const { data, error } = await client.auth.getSession();
  if (!supabase) return false;
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    console.warn('Unable to check Supabase session', error);
    return false;
  }
  return Boolean(data?.session?.access_token);
}

window.addEventListener('DOMContentLoaded', async () => {
  const allowed = await requireSession();
  if (!allowed) {
    window.location.href = 'index.html';
    return;
  }
  init();
});
