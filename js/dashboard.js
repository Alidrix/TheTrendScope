const { createClient } = window.supabase || {};
const supabase =
  window.supabaseClient ||
  (createClient && window.SUPABASE_URL && window.SUPABASE_ANON_KEY
    ? createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY)
    : null);
const LOCAL_SESSION_KEY = 'trendscope.local.session';

const state = {
  videos: [],
  stats: {},
  notes: {},
  filters: { category: 'all', region: 'all', language: 'all' },
  loading: false,
};

const elements = {
  grid: document.getElementById('video-grid'),
  categorySelect: document.getElementById('filter-category'),
  regionSelect: document.getElementById('filter-region'),
  languageSelect: document.getElementById('filter-language'),
  refreshBtn: document.getElementById('refresh-btn'),
  toastContainer: document.querySelector('.toast-container'),
  notificationList: document.querySelector('.notifications'),
  pageLoader: document.querySelector('.page-loader'),
};

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
}

function applyFilters(video) {
  const { category, region, language } = state.filters;
  const matchesCategory = category === 'all' || video.category === category;
  const matchesRegion = region === 'all' || video.region === region;
  const matchesLanguage = language === 'all' || video.language === language;
  return matchesCategory && matchesRegion && matchesLanguage;
}

function renderCards() {
  if (!elements.grid) return;
  const filtered = state.videos.filter(applyFilters);
  if (filtered.length === 0) {
    elements.grid.innerHTML = '<div class="empty">No videos match these filters right now.</div>';
    return;
  }

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
        <h3 class="title">${video.title || 'Untitled video'}</h3>
        <div class="meta">${video.creator || 'Unknown creator'}</div>
        <div class="stats">
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
        ${note?.content ? `<div class="meta">Note: ${note.content}</div>` : ''}
      </div>
    </article>
  `;
}

function notify(message, type = 'info') {
  if (elements.toastContainer) {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    elements.toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
  }
  addNotification(message, type);
}

function addNotification(message, type = 'info') {
  if (!elements.notificationList) return;
  const item = document.createElement('div');
  item.className = `notification ${type}`;
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  item.innerHTML = `<span class="message">${message}</span><span class="time">${time}</span>`;
  elements.notificationList.prepend(item);
  const max = 5;
  while (elements.notificationList.children.length > max) {
    elements.notificationList.lastChild.remove();
  }
}

function formatNumber(value) {
  if (value === undefined || value === null || Number.isNaN(value)) return '—';
  return Number(value).toLocaleString();
}

async function refreshTrends() {
  elements.pageLoader?.classList.add('active');
  setButtonBusy(true);
  try {
    const response = await fetch('/api/refresh', { method: 'POST' });
    if (!response.ok) throw new Error('Refresh failed');
    notify('Refresh started. Updating data…', 'info');
    await loadData();
    notify('Trends refreshed.', 'success');
  } catch (error) {
    notify(error.message, 'error');
  } finally {
    setButtonBusy(false);
    elements.pageLoader?.classList.remove('active');
  }
}

function setButtonBusy(isBusy) {
  if (!elements.refreshBtn) return;
  elements.refreshBtn.disabled = isBusy;
  elements.refreshBtn.innerHTML = isBusy
    ? '<span class="loader"><span class="dot"></span><span class="dot"></span><span class="dot"></span> Refreshing…</span>'
    : '<i class="fa fa-refresh"></i> Refresh trends';
}

async function loadData() {
  try {
    state.loading = true;
    elements.pageLoader?.classList.add('active');
    const videos = await fetchVideos();

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

    renderFilters();
    renderCards();
    notify('Dashboard updated.', 'success');
  } catch (error) {
    console.error(error);
  } finally {
    state.loading = false;
    elements.pageLoader?.classList.remove('active');
  }
}

function bindFilterEvents() {
  elements.categorySelect?.addEventListener('change', (event) => {
    state.filters.category = event.target.value;
    renderCards();
  });
  elements.regionSelect?.addEventListener('change', (event) => {
    state.filters.region = event.target.value;
    renderCards();
  });
  elements.languageSelect?.addEventListener('change', (event) => {
    state.filters.language = event.target.value;
    renderCards();
  });
}

function init() {
  if (!elements.grid) return;
  bindFilterEvents();
  elements.refreshBtn?.addEventListener('click', refreshTrends);
  if (!supabase) {
    notify('Supabase client is not configured. Set window.SUPABASE_URL and window.SUPABASE_ANON_KEY.', 'warning');
  }
  loadData();
}

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
