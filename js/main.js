(() => {
  const state = {
    token: null,
    videos: [],
    history: [],
    notifications: [],
    filters: {
      country: 'FR',
      category: '',
      search: '',
      shortOnly: false,
    },
  };

  const setFullHeight = () => {
    document.querySelectorAll('.js-fullheight').forEach((el) => {
      el.style.height = `${window.innerHeight}px`;
    });
  };

  const initPasswordToggle = () => {
    document.querySelectorAll('[data-toggle="password"]').forEach((toggle) => {
      toggle.addEventListener('click', () => {
        const targetSelector = toggle.getAttribute('data-target');
        if (!targetSelector) return;
        const input = document.querySelector(targetSelector);
        if (!input) return;
        const isHidden = input.getAttribute('type') === 'password';
        input.setAttribute('type', isHidden ? 'text' : 'password');
        const icon = toggle.querySelector('i');
        if (icon) {
          icon.classList.toggle('fa-eye');
          icon.classList.toggle('fa-eye-slash');
        }
      });
    });
  };

  const toast = (message, variant = 'success') => {
    const toastEl = document.getElementById('toast');
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.className = `toast ${variant === 'error' ? 'error' : ''} is-visible`;
    setTimeout(() => {
      toastEl.classList.remove('is-visible');
    }, 2800);
  };

  const updateStatus = (message, variant = 'success') => {
    const status = document.getElementById('login-status');
    if (!status) return;
    status.textContent = message;
    status.className = `status is-visible status--${variant}`;
  };

  const api = async (path, options = {}) => {
    const headers = options.headers || {};
    if (state.token) headers['X-Admin-Token'] = state.token;
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, { ...options, headers });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.error || 'Requête échouée');
    }
    return res.json();
  };

  const updateHealthBadges = (health = {}) => {
    const container = document.getElementById('health-status');
    if (!container) return;
    container.querySelectorAll('.status-badge').forEach((badge) => {
      const key = badge.getAttribute('data-key');
      const ok = Boolean(health[key]);
      badge.classList.toggle('is-ok', ok);
      badge.classList.toggle('is-ko', !ok);
      badge.textContent = `${key.toUpperCase()} ${ok ? 'UP' : 'KO'}`;
    });
  };

  const renderStats = () => {
    const totalEl = document.querySelector('[data-stat="total"]');
    const shortsEl = document.querySelector('[data-stat="shorts"]');
    const velocityEl = document.querySelector('[data-stat="velocity"]');

    const total = state.videos.length;
    const shorts = state.videos.filter((v) => v.is_short).length;
    const avgVelocity = state.videos.length
      ? Math.round(state.videos.reduce((acc, v) => acc + Number(v.velocity_per_hour || 0), 0) / state.videos.length)
      : 0;

    if (totalEl) totalEl.textContent = total;
    if (shortsEl) shortsEl.textContent = shorts;
    if (velocityEl) velocityEl.textContent = avgVelocity.toLocaleString('fr-FR');
  };

  const renderNotifications = () => {
    const list = document.getElementById('notification-list');
    const count = document.getElementById('notif-count');
    if (!list) return;
    list.innerHTML = '';
    state.notifications.forEach((notif) => {
      const li = document.createElement('li');
      li.className = 'notification';
      li.innerHTML = `
        <div>
          <strong>${notif.title}</strong>
          <div class="small text-muted">${notif.country} • Vélocité ${Math.round(notif.velocity_per_hour).toLocaleString('fr-FR')} v/h</div>
          ${notif.note ? `<div class="small">Note: ${notif.note}</div>` : ''}
        </div>
        <small>${notif.is_short ? 'Short' : ''} ${notif.freshness_hours}h</small>
      `;
      list.appendChild(li);
    });
    if (count) count.textContent = `${state.notifications.length} alertes`;
  };

  const renderHistory = () => {
    const container = document.getElementById('history-content');
    const title = document.getElementById('history-title');
    if (!container) return;
    if (!state.history.length) {
      container.textContent = 'Aucun historique chargé.';
      if (title) title.textContent = 'Sélectionne une vidéo';
      return;
    }
    container.innerHTML = '';
    state.history.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'history-item';
      row.innerHTML = `
        <span>${new Date(item.recorded_at).toLocaleString('fr-FR')}</span>
        <span>${Number(item.view_count || 0).toLocaleString('fr-FR')} vues • ${Number(item.like_count || 0).toLocaleString('fr-FR')} likes</span>
      `;
      container.appendChild(row);
    });
    if (title) title.textContent = `${state.history.length} points de données`;
  };

  const saveFilters = () => {
    localStorage.setItem('trendScopeFilters', JSON.stringify(state.filters));
  };

  const loadFilters = () => {
    const raw = localStorage.getItem('trendScopeFilters');
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      state.filters = { ...state.filters, ...parsed };
    } catch (err) {
      // ignore
    }
  };

  const applyFiltersToForm = () => {
    document.getElementById('filter-country').value = state.filters.country;
    document.getElementById('filter-category').value = state.filters.category;
    document.getElementById('filter-search').value = state.filters.search;
    document.getElementById('filter-short').checked = state.filters.shortOnly;
  };

  const renderTable = () => {
    const tbody = document.querySelector('#video-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    state.videos.forEach((video) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>
          <div class="fw-bold text-light">${video.title}</div>
          <div class="small text-muted">${video.description?.slice(0, 80) || ''}</div>
          <div class="small"><a href="https://www.youtube.com/watch?v=${video.id}" target="_blank" rel="noopener">Ouvrir sur YouTube</a></div>
        </td>
        <td>${video.country}</td>
        <td>${video.category || '-'}</td>
        <td>${Number(video.view_count || 0).toLocaleString('fr-FR')}</td>
        <td>${Math.round(video.velocity_per_hour || 0).toLocaleString('fr-FR')}</td>
        <td>${video.is_short ? '<span class="badge badge-short">Short</span>' : '-'}</td>
        <td>
          <textarea class="note-input" data-id="${video.id}" rows="2" placeholder="Ta note perso…">${video.note || ''}</textarea>
          <div class="note-actions">
            <label class="checkbox-wrap checkbox-primary">Utilisée
              <input type="checkbox" data-used="${video.id}" ${video.used ? 'checked' : ''}>
              <span class="checkmark"></span>
            </label>
            <button class="btn btn-outline btn-save" data-save="${video.id}">Sauvegarder</button>
            <button class="btn btn-outline btn-history" data-history="${video.id}">Historique</button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });
  };

  const fetchVideos = async () => {
    const params = new URLSearchParams();
    if (state.filters.country) params.set('country', state.filters.country);
    if (state.filters.category) params.set('category', state.filters.category);
    if (state.filters.search) params.set('search', state.filters.search);
    if (state.filters.shortOnly) params.set('shortOnly', 'true');

    const { items } = await api(`/api/videos?${params.toString()}`);
    state.videos = items || [];
    renderStats();
    renderTable();
  };

  const fetchNotifications = async () => {
    const { items } = await api('/api/notifications');
    state.notifications = items || [];
    renderNotifications();
  };

  const fetchHistory = async (id) => {
    const { items } = await api(`/api/videos/${id}/history`);
    state.history = items || [];
    renderHistory();
  };

  const refreshTrending = async () => {
    const { country } = state.filters;
    await api('/api/videos/refresh', {
      method: 'POST',
      body: JSON.stringify({ country, maxResults: 10 }),
    });
    toast(`Rafraîchissement lancé pour ${country}.`);
    await fetchVideos();
    await fetchNotifications();
  };

  const saveVideo = async (id) => {
    const noteField = document.querySelector(`textarea[data-id="${id}"]`);
    const usedField = document.querySelector(`input[data-used="${id}"]`);
    const note = noteField?.value || '';
    const used = usedField?.checked || false;
    await api(`/api/videos/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ note, used }),
    });
    toast('Note synchronisée avec Supabase');
    await fetchNotifications();
  };

  const showDashboard = (health) => {
    document.getElementById('login-screen')?.classList.add('d-none');
    document.getElementById('dashboard')?.classList.remove('d-none');
    updateHealthBadges(health);
  };

  const handleLogin = () => {
    const form = document.getElementById('login-form');
    const usernameInput = document.getElementById('username');
    const passwordInput = document.getElementById('password');
    const rememberInput = document.getElementById('remember');

    if (!form || !usernameInput || !passwordInput) return;

    const storedUser = localStorage.getItem('trendScopeUser');
    const storedPass = localStorage.getItem('trendScopePass');
    if (storedUser) usernameInput.value = storedUser;
    if (storedPass) passwordInput.value = storedPass;

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const username = usernameInput.value.trim();
      const password = passwordInput.value.trim();
      const remember = rememberInput?.checked;

      if (!username || !password) {
        updateStatus('Merci de renseigner un identifiant et un mot de passe.', 'error');
        return;
      }

      if (remember) {
        localStorage.setItem('trendScopeUser', username);
        localStorage.setItem('trendScopePass', password);
      } else {
        localStorage.removeItem('trendScopeUser');
        localStorage.removeItem('trendScopePass');
      }

      updateStatus('Connexion en cours…');
      try {
        const { token, health } = await api('/api/login', {
          method: 'POST',
          body: JSON.stringify({ username, password }),
        });
        state.token = token;
        localStorage.setItem('trendScopeToken', token);
        updateStatus('Connexion validée par Supabase et JWT actifs.', 'success');
        toast('Connexion OK : Supabase et JWT UP');
        showDashboard(health);
        await fetchVideos();
        await fetchNotifications();
      } catch (err) {
        updateStatus(err.message, 'error');
        toast(err.message, 'error');
      }
    });
  };

  const bindFilters = () => {
    const country = document.getElementById('filter-country');
    const category = document.getElementById('filter-category');
    const search = document.getElementById('filter-search');
    const shortOnly = document.getElementById('filter-short');

    [country, category, search, shortOnly].forEach((input) => {
      input?.addEventListener('change', async () => {
        state.filters = {
          ...state.filters,
          country: country?.value || 'FR',
          category: category?.value || '',
          search: search?.value || '',
          shortOnly: Boolean(shortOnly?.checked),
        };
        saveFilters();
        await fetchVideos();
        await fetchNotifications();
      });
    });
  };

  const bindTableActions = () => {
    const table = document.getElementById('video-table');
    if (!table) return;
    table.addEventListener('click', async (event) => {
      const saveBtn = event.target.closest('[data-save]');
      const historyBtn = event.target.closest('[data-history]');
      if (saveBtn) {
        const id = saveBtn.getAttribute('data-save');
        await saveVideo(id);
      }
      if (historyBtn) {
        const id = historyBtn.getAttribute('data-history');
        await fetchHistory(id);
      }
    });
  };

  const bindButtons = () => {
    document.getElementById('btn-refresh')?.addEventListener('click', refreshTrending);
    document.getElementById('btn-load')?.addEventListener('click', async () => {
      await fetchVideos();
      await fetchNotifications();
    });
    document.getElementById('btn-logout')?.addEventListener('click', () => {
      localStorage.removeItem('trendScopeToken');
      document.getElementById('dashboard')?.classList.add('d-none');
      document.getElementById('login-screen')?.classList.remove('d-none');
    });
  };

  const restoreSession = async () => {
    const token = localStorage.getItem('trendScopeToken');
    if (!token) return;
    state.token = token;
    try {
      const health = await api('/api/health');
      showDashboard(health);
      loadFilters();
      applyFiltersToForm();
      await fetchVideos();
      await fetchNotifications();
    } catch (err) {
      console.warn('Session expirée', err.message);
      localStorage.removeItem('trendScopeToken');
    }
  };

  document.addEventListener('DOMContentLoaded', async () => {
    setFullHeight();
    window.addEventListener('resize', setFullHeight);
    initPasswordToggle();
    loadFilters();
    applyFiltersToForm();
    handleLogin();
    bindFilters();
    bindButtons();
    bindTableActions();
    await restoreSession();
  });
})();
