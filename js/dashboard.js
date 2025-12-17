const { createClient } = window.supabase || {};

const supabaseUrl = window.SUPABASE_URL || '';
const supabaseKey = window.SUPABASE_ANON_KEY || '';
const supabase = createClient && supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

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
    .from('videos')
    .select('id, title, creator, thumbnail_url, is_short, region, category, language');
  if (error) {
    notify(`Error fetching videos: ${error.message}`, 'error');
    throw error;
  }
  return data || [];
}

async function fetchStatsSnapshot() {
  if (!supabase) return {};
  const { data, error } = await supabase
    .from('stats_snapshots')
    .select('video_id, initial_views, current_views, views_per_hour, created_at')
    .order('created_at', { ascending: false });
  if (error) {
    notify(`Error fetching stats: ${error.message}`, 'error');
    throw error;
  }
  const latest = {};
  data?.forEach((row) => {
    if (!latest[row.video_id]) {
      latest[row.video_id] = row;
    }
  });
  return latest;
}

async function fetchNotes(videoIds = []) {
  if (!supabase || videoIds.length === 0) return {};
  const { data, error } = await supabase
    .from('notes')
    .select('video_id, content, updated_at')
    .in('video_id', videoIds);
  if (error) {
    notify(`Error loading notes: ${error.message}`, 'error');
    throw error;
  }
  const noteMap = {};
  data?.forEach((row) => {
    noteMap[row.video_id] = row;
  });
  return noteMap;
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
  select.innerHTML = '<option value="all">All</option>' +
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
  bindCardActions();
}

function buildCard(video, stat = {}, note = {}) {
  const delta = (stat.current_views || 0) - (stat.initial_views || 0);
  const deltaClass = delta >= 0 ? 'trend-up' : 'trend-down';
  const deltaLabel = delta >= 0 ? '▲' : '▼';
  return `
    <article class="card" data-id="${video.id}">
      <div class="thumb">
        <img src="${video.thumbnail_url || 'images/bg.jpg'}" alt="${video.title}">
        <div class="badges">
          ${video.is_short ? '<span class="badge short">Short</span>' : ''}
          ${video.language ? `<span class="badge language">${video.language}</span>` : ''}
          ${video.region ? `<span class="badge region">${video.region}</span>` : ''}
          ${video.category ? `<span class="badge category">${video.category}</span>` : ''}
        </div>
      </div>
      <div class="content">
        <h3 class="title">${video.title || 'Untitled video'}</h3>
        <div class="meta">${video.creator || 'Unknown creator'}</div>
        <div class="stats">
          <div class="stat">
            <span class="label">Initial views</span>
            <span class="value">${formatNumber(stat.initial_views)}</span>
          </div>
          <div class="stat">
            <span class="label">Current views</span>
            <span class="value">${formatNumber(stat.current_views)}</span>
          </div>
          <div class="stat">
            <span class="label">Δ views</span>
            <span class="value ${deltaClass}">${deltaLabel} ${formatNumber(Math.abs(delta))}</span>
          </div>
          <div class="stat">
            <span class="label">Views / hour</span>
            <span class="value">${formatNumber(stat.views_per_hour)}</span>
          </div>
        </div>
        <div class="actions-row">
          <button class="btn ghost mark-used">Mark as used</button>
          <button class="btn secondary add-note">${note?.content ? 'Edit note' : 'Add note'}</button>
        </div>
        ${note?.content ? `<div class="meta">Note: ${note.content}</div>` : ''}
      </div>
    </article>
  `;
}

function bindCardActions() {
  document.querySelectorAll('.mark-used').forEach((btn) =>
    btn.addEventListener('click', (event) => {
      const card = event.target.closest('.card');
      markAsUsed(card.dataset.id, card);
    })
  );

  document.querySelectorAll('.add-note').forEach((btn) =>
    btn.addEventListener('click', (event) => {
      const card = event.target.closest('.card');
      openNoteEditor(card.dataset.id);
    })
  );
}

async function markAsUsed(videoId, card) {
  if (!supabase) {
    notify('Supabase is not configured.', 'error');
    return;
  }
  try {
    toggleCardBusy(card, true);
    const { error } = await supabase
      .from('videos')
      .update({ status: 'used', used_at: new Date().toISOString() })
      .eq('id', videoId);
    if (error) throw error;
    state.videos = state.videos.filter((video) => video.id !== videoId);
    notify('Video moved to history.', 'success');
    renderCards();
  } catch (error) {
    notify(`Unable to mark as used: ${error.message}`, 'error');
  } finally {
    toggleCardBusy(card, false);
  }
}

async function openNoteEditor(videoId) {
  const existing = state.notes[videoId]?.content || '';
  const content = prompt('Add a note for this video:', existing);
  if (content === null) return;
  if (!supabase) {
    notify('Supabase is not configured.', 'error');
    return;
  }
  try {
    const { data, error } = await supabase
      .from('notes')
      .upsert({ video_id: videoId, content, updated_at: new Date().toISOString() }, { onConflict: 'video_id' })
      .select();
    if (error) throw error;
    state.notes[videoId] = data?.[0];
    notify('Note saved.', 'success');
    renderCards();
  } catch (error) {
    notify(`Unable to save note: ${error.message}`, 'error');
  }
}

function toggleCardBusy(card, busy) {
  if (!card) return;
  card.style.opacity = busy ? 0.6 : 1;
  card.style.pointerEvents = busy ? 'none' : 'auto';
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
    const stats = await fetchStatsSnapshot();
    const notes = await fetchNotes(videos.map((v) => v.id));

    state.videos = videos;
    state.stats = stats;
    state.notes = notes;

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

window.addEventListener('DOMContentLoaded', init);
