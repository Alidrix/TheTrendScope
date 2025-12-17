const categories = [
  'nourriture',
  'voiture',
  'business',
  'drôle',
  'influenceurs',
  'gaming',
  'sport',
  'musique'
];

let sessionToken = localStorage.getItem('trendScopeSession') || '';
let historyChart;

const $ = (q) => document.querySelector(q);
const toastEl = $('#toast');
const loaderEl = $('#loader');

function toggleTheme() {
  const root = document.documentElement;
  const nextTheme = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  root.setAttribute('data-theme', nextTheme);
  localStorage.setItem('trendScopeTheme', nextTheme);
}

function showToast(message, duration = 2200) {
  toastEl.textContent = message;
  toastEl.classList.remove('hidden');
  setTimeout(() => toastEl.classList.add('hidden'), duration);
}

function setLoading(isLoading) {
  loaderEl.classList.toggle('hidden', !isLoading);
}

async function fetchJson(url, options = {}) {
  return fetch(url, options);
  const headers = options.headers || {};
  if (sessionToken) {
    headers['x-session-token'] = sessionToken;
  }
  return fetch(url, { ...options, headers });
}

function renderCategoryChips() {
  const container = $('#categoryChips');
  container.innerHTML = '';
  ['tout', ...categories].forEach((cat) => {
    const chip = document.createElement('button');
    chip.className = 'chip ghost';
    chip.textContent = cat;
    chip.dataset.value = cat === 'tout' ? '' : cat;
    chip.addEventListener('click', () => {
      document.querySelectorAll('#categoryChips button').forEach((c) => c.classList.remove('primary'));
      chip.classList.add('primary');
      container.dataset.selected = chip.dataset.value;
    });
    if (cat === 'tout') chip.classList.add('primary');
    container.appendChild(chip);
  });
}

function updateSessionStatus(label, ok) {
  const badge = $('#sessionStatus');
  badge.textContent = label;
  badge.classList.toggle('ghost', !ok);
}

async function login(e) {
  e.preventDefault();
  setLoading(true);
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: $('#username').value,
        password: $('#password').value
      })
    });
    if (!res.ok) throw new Error('Identifiants invalides');
    const data = await res.json();
    sessionToken = data.token;
    localStorage.setItem('trendScopeSession', sessionToken);
    updateSessionStatus('Connecté', true);
    showToast('Session ouverte');
    await refreshVideos();
    await loadHistory();
    await loadNotifications();
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Erreur de connexion');
  } finally {
    setLoading(false);
  }
}

async function refreshTrends() {
  setLoading(true);
  const selected = document.querySelector('#categoryChips').dataset.selected || '';
  try {
    const res = await fetchJson('/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        country: $('#country').value,
        language: $('#language').value,
        category: selected,
        maxResults: Number($('#maxResults').value) || 12,
        alertThreshold: Number($('#alertThreshold').value) || 12000
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Rafraîchissement impossible');
    showToast('Tendances mises à jour');
    renderVideos(data.videos || []);
    renderStats(data.videos || []);
    renderNotifications(data.notifications || []);
    await loadHistory();
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Erreur pendant le rafraîchissement');
  } finally {
    setLoading(false);
  }
}

function renderStats(videos) {
  const container = $('#statSummary');
  const totalViews = videos.reduce((acc, v) => acc + (v.view_count || 0), 0);
  const avgVelocity = videos.length ? Math.round(videos.reduce((acc, v) => acc + (v.velocity_per_hour || 0), 0) / videos.length) : 0;
  const shorts = videos.filter((v) => v.is_short).length;
  container.innerHTML = `
    <div class="stat-card"><span class="muted">Vidéos suivies</span><strong>${videos.length}</strong></div>
    <div class="stat-card"><span class="muted">Vues totales</span><strong>${totalViews.toLocaleString()}</strong></div>
    <div class="stat-card"><span class="muted">Vélocité moyenne</span><strong>${avgVelocity.toLocaleString()} vues/h</strong></div>
    <div class="stat-card"><span class="muted">Shorts</span><strong>${shorts}</strong></div>
  `;
}

function renderVideos(videos) {
  const grid = $('#videoGrid');
  grid.innerHTML = '';
  videos.forEach((v) => {
    const card = document.createElement('article');
    card.className = `card ${v.used ? 'used' : ''}`;
    card.innerHTML = `
      <img src="${v.thumbnail_url}" alt="${v.title}" />
      <div class="body">
        <div class="meta">
          <span class="badge">${v.country}</span>
          <span class="badge">${v.category || 'N/A'}</span>
          ${v.is_short ? '<span class="badge">Short</span>' : ''}
        </div>
        <h3>${v.title}</h3>
        <p class="muted">${v.channel_title || 'Chaîne inconnue'}</p>
        <div class="meta">
          <span>👁️ ${Number(v.view_count || 0).toLocaleString()}</span>
          <span>👍 ${Number(v.like_count || 0).toLocaleString()}</span>
          <span>🚀 ${Math.round(v.velocity_per_hour || 0).toLocaleString()} vues/h</span>
        </div>
        <div class="actions">
          <button class="primary" data-action="preview" data-id="${v.id}">▶ Prévisualiser</button>
          <button class="ghost" data-action="refresh" data-id="${v.id}">🔄 Stats</button>
          <button class="ghost" data-action="used" data-id="${v.id}">✅ Utilisée</button>
        </div>
        <label class="input note">
          <span>Note personnelle</span>
          <textarea rows="2" data-id="${v.id}" placeholder="Ajoute une note…">${v.note || ''}</textarea>
          <button class="primary" data-action="note" data-id="${v.id}">💾 Sauvegarder</button>
        </label>
      </div>
    `;
    grid.appendChild(card);
  });
}

async function refreshVideos() {
  try {
    const res = await fetchJson('/api/videos');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Impossible de charger les vidéos');
    renderVideos(data.videos || []);
    renderStats(data.videos || []);
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Erreur de chargement');
  }
}

async function handleCardAction(e) {
  const btn = e.target.closest('button');
  if (!btn || !btn.dataset.action) return;
  const id = btn.dataset.id;
  const action = btn.dataset.action;
  if (action === 'preview') return openPreview(id);
  if (action === 'note') {
    const textarea = btn.parentElement.querySelector('textarea');
    return saveNote(id, textarea.value);
  }
  if (action === 'used') return markUsed(id);
  if (action === 'refresh') return refreshStatsFor(id);
}

function openPreview(id) {
  const modal = $('#previewModal');
  $('#previewFrame').src = `https://www.youtube.com/embed/${id}`;
  modal.showModal();
}

async function saveNote(id, note) {
  const res = await fetchJson(`/api/videos/${id}/note`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note })
  });
  const data = await res.json();
  if (!res.ok) return showToast(data.error || 'Erreur note');
  showToast('Note enregistrée');
}

async function markUsed(id) {
  const res = await fetchJson(`/api/videos/${id}/mark-used`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) return showToast(data.error || 'Erreur de marquage');
  showToast('Vidéo marquée comme utilisée');
  await refreshVideos();
  await loadHistory();
}

async function refreshStatsFor(id) {
  const res = await fetchJson(`/api/videos/${id}/refresh`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) return showToast(data.error || 'Erreur mise à jour');
  showToast('Statistiques mises à jour');
  await refreshVideos();
  await loadHistory();
}

async function refreshAllStats() {
  setLoading(true);
  try {
    const res = await fetchJson('/api/refresh-stats', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Impossible de rafraîchir');
    showToast('Statistiques actualisées');
    renderVideos(data.videos || []);
    renderStats(data.videos || []);
    await loadHistory();
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Erreur');
  } finally {
    setLoading(false);
  }
}

async function loadHistory() {
  const res = await fetchJson('/api/history');
  const data = await res.json();
  if (!res.ok) return;
  $('#historyCounter').textContent = `${data.history.length} enregistrements`;
  if (!historyChart) {
    historyChart = new Chart($('#historyChart'), {
      type: 'line',
      data: { labels: [], datasets: [] },
      options: { responsive: true, plugins: { legend: { display: true } } }
    });
  }
  const labels = data.history.map((h) => new Date(h.recorded_at).toLocaleString());
  historyChart.data.labels = labels;
  historyChart.data.datasets = [
    {
      label: 'Vues',
      borderColor: '#60a5fa',
      backgroundColor: 'rgba(96,165,250,0.2)',
      data: data.history.map((h) => h.view_count)
    },
    {
      label: 'Likes',
      borderColor: '#22c55e',
      backgroundColor: 'rgba(34,197,94,0.2)',
      data: data.history.map((h) => h.like_count)
    }
  ];
  historyChart.update();
}

async function loadNotifications() {
  const res = await fetchJson('/api/notifications');
  const data = await res.json();
  if (!res.ok) return;
  renderNotifications(data.notifications || []);
}

function renderNotifications(list) {
  $('#notificationCounter').textContent = `${list.length} alertes`;
  const container = $('#notificationList');
  container.innerHTML = '';
  if (!list.length) {
    container.innerHTML = '<p class="muted">Aucune alerte</p>';
    return;
  }
  list.forEach((n) => {
    const item = document.createElement('div');
    item.className = `notification ${n.level || ''}`;
    item.innerHTML = `<strong>${n.title}</strong><p class="muted">${n.message}</p>`;
    container.appendChild(item);
  });
}

async function exportHistory(format) {
  const url = `/api/export?format=${format}`;
  const res = await fetchJson(url);
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = `history.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}

function restoreTheme() {
  const saved = localStorage.getItem('trendScopeTheme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
}

function bindEvents() {
  $('#themeToggle').addEventListener('click', toggleTheme);
  $('#loginForm').addEventListener('submit', login);
  $('#refreshBtn').addEventListener('click', refreshTrends);
  $('#refreshStatsBtn').addEventListener('click', refreshAllStats);
  $('#videoGrid').addEventListener('click', handleCardAction);
  $('#closePreview').addEventListener('click', () => $('#previewModal').close());
  $('#exportCsvBtn').addEventListener('click', () => exportHistory('csv'));
  $('#exportJsonBtn').addEventListener('click', () => exportHistory('json'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('#previewModal').open) $('#previewModal').close();
  });
}

async function bootstrap() {
  restoreTheme();
  renderCategoryChips();
  bindEvents();
  await refreshVideos();
  await loadHistory();
  await loadNotifications();
  if (sessionToken) {
    updateSessionStatus('Session mémorisée', true);
    await refreshVideos();
    await loadHistory();
    await loadNotifications();
  }
}

bootstrap();
