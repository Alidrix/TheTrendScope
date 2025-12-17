(function () {
  "use strict";

  const ALERT_THRESHOLD = 500000;
  const LOCAL_SESSION_KEY = "trendscope.local.session";

  const fallbackVideos = [
    {
      id: "fallback-1",
      youtube_id: "H2x5Lw",
      title: "AI trailer rewrites break the internet",
      channel: "Creator Lab",
      thumbnail_url:
        "https://images.unsplash.com/photo-1498050108023-c5249f4df085?auto=format&fit=crop&w=900&q=60",
      views: 9820000,
      views_per_hour: 742000,
      published_at: "2024-08-16T13:00:00Z",
      video_url: "https://www.youtube.com/watch?v=H2x5Lw",
    },
    {
      id: "fallback-2",
      youtube_id: "t9M2vb",
      title: "24h speedrun of the world’s hardest puzzle",
      channel: "Puzzle Forge",
      thumbnail_url:
        "https://images.unsplash.com/photo-1522199710521-72d69614c702?auto=format&fit=crop&w=900&q=60",
      views: 4512000,
      views_per_hour: 529000,
      published_at: "2024-08-16T09:15:00Z",
      video_url: "https://www.youtube.com/watch?v=t9M2vb",
    },
    {
      id: "fallback-3",
      youtube_id: "kX2jQz",
      title: "Live: breaking tech earnings",
      channel: "MarketStream",
      thumbnail_url:
        "https://images.unsplash.com/photo-1556761175-5973dc0f32e7?auto=format&fit=crop&w=900&q=60",
      views: 1210000,
      views_per_hour: 312000,
      published_at: "2024-08-16T08:00:00Z",
      video_url: "https://www.youtube.com/watch?v=kX2jQz",
    },
    {
      id: "fallback-4",
      youtube_id: "Jd83Az",
      title: "How to film cinematic drone shots",
      channel: "Skyline Studio",
      thumbnail_url:
        "https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=900&q=60",
      views: 890000,
      views_per_hour: 221000,
      published_at: "2024-08-16T07:30:00Z",
      video_url: "https://www.youtube.com/watch?v=Jd83Az",
    },
  ];

  const dom = {
    dashboardShell: document.getElementById("dashboard-shell"),
    loginShell: document.getElementById("login-shell"),
    navbar: document.querySelector(".dashboard-nav"),
    videoGrid: document.getElementById("video-grid"),
    alertCountBadge: document.getElementById("alert-count-badge"),
    alertFeedCount: document.getElementById("alert-feed-count"),
    alertList: document.getElementById("alert-list"),
    alertEmpty: document.getElementById("alert-empty"),
    alertPanel: document.getElementById("alert-panel"),
    alertPanelToggle: document.getElementById("alertPanelToggle"),
    alertPanelClose: document.getElementById("alertPanelClose"),
    alertPanelList: document.getElementById("alert-panel-list"),
    status: document.getElementById("data-status"),
    lastRefreshed: document.getElementById("last-refreshed"),
    loginForm: document.querySelector(".signin-form"),
    usernameField: document.getElementById("username-field"),
    passwordField: document.getElementById("password-field"),
    submitButton: document.getElementById("login-submit"),
    loader: document.getElementById("sign-in-loader"),
    feedback: document.getElementById("login-feedback"),
    toastContainer: document.getElementById("toast-container"),
    passwordToggle: document.querySelector(".toggle-password"),
  };

  const supabaseClient =
    window.supabaseClient ||
    (window.supabase && window.SUPABASE_URL && window.SUPABASE_ANON_KEY
      ? window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY)
      : null);

  const authConfig = window.authConfig || {};

  const state = {
    videos: [],
    alerts: [],
    source: "",
    dashboardLoaded: false,
  };

  function setShell(view) {
    if (dom.dashboardShell) {
      dom.dashboardShell.classList.toggle("d-none", view !== "dashboard");
    }
    if (dom.loginShell) {
      dom.loginShell.classList.toggle("d-none", view !== "login");
    }
    if (dom.navbar) {
      dom.navbar.classList.toggle("d-none", view !== "dashboard");
    }
  }

  function formatNumber(value) {
    if (value === undefined || value === null) return "0";
    return new Intl.NumberFormat("en", { notation: "compact" }).format(value);
  }

  function formatTimeAgo(dateString) {
    if (!dateString) return "";
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return "";
    const now = new Date();
    const diff = Math.max(0, now - date);
    const diffHours = Math.floor(diff / (1000 * 60 * 60));
    if (diffHours < 1) return "Just now";
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  }

  function setStatus(message, variant = "info") {
    if (!dom.status) return;
    dom.status.classList.remove("d-none", "alert-info", "alert-warning", "alert-danger", "alert-success");
    dom.status.classList.add(`alert-${variant}`);
    dom.status.textContent = message;
  }

  function clearStatus() {
    if (!dom.status) return;
    dom.status.classList.add("d-none");
    dom.status.textContent = "";
  }

  function normalizeVideos(rawVideos) {
    return (rawVideos || []).map((video, index) => {
      const viewsPerHour = Number(
        video.views_per_hour || video.viewsPerHour || video.viewsperhour || 0
      );
      const alertFlag = viewsPerHour >= ALERT_THRESHOLD || video.alert === true;
      const youtubeId = video.youtube_id || video.youtubeId || video.id || `video-${index}`;
      const videoUrl =
        video.video_url ||
        video.url ||
        (youtubeId ? `https://www.youtube.com/watch?v=${youtubeId}` : "");

      return {
        id: video.id || youtubeId || `video-${index}`,
        youtube_id: youtubeId,
        title: video.title || video.name || "Untitled video",
        channel: video.channel || video.channel_title || video.channel_name || "Unknown channel",
        thumbnail_url: video.thumbnail_url || video.thumbnail || video.thumbnailUrl || "",
        views: Number(video.views || video.total_views || video.current_views || 0),
        views_per_hour: viewsPerHour,
        published_at: video.published_at || video.publishedAt || video.collected_at || video.created_at || "",
        alert: alertFlag,
        video_url: videoUrl,
      };
    });
  }

  function updateState(videos, source) {
    state.videos = videos;
    state.alerts = videos.filter((video) => video.alert);
    state.source = source;
  }

  async function fetchVideosFromSupabase() {
    if (!supabaseClient) {
      throw new Error("Supabase client is unavailable");
    }

    const { data, error } = await supabaseClient
      .from("video_feed")
      .select(
        "id,youtube_id,title,channel_title,thumbnail_url,views,views_per_hour,published_at,collected_at"
      )
      .order("collected_at", { ascending: false, nullsLast: true })
      .order("views_per_hour", { ascending: false, nullsLast: true });

    if (error) throw error;
    return data || [];
  }

  function renderVideoCard(video) {
    const col = document.createElement("div");
    col.className = "col-md-6 col-xl-4 mb-4";

    const card = document.createElement("div");
    card.className = "card video-card shadow-sm h-100";
    if (video.alert) card.classList.add("video-card-alert");

    const thumb = document.createElement("a");
    thumb.className = "video-thumb d-block";
    thumb.href = video.video_url || "#";
    thumb.target = "_blank";
    thumb.rel = "noopener noreferrer";
    if (video.thumbnail_url) {
      thumb.style.backgroundImage = `url(${video.thumbnail_url})`;
    } else {
      thumb.classList.add("video-thumb-placeholder");
    }

    if (video.alert) {
      const badge = document.createElement("span");
      badge.className = "alert-pill";
      badge.textContent = "🔥 Alert";
      thumb.appendChild(badge);
    }

    const cardBody = document.createElement("div");
    cardBody.className = "card-body d-flex flex-column";

    const titleRow = document.createElement("div");
    titleRow.className = "d-flex align-items-start mb-2";
    const title = document.createElement("h5");
    title.className = "card-title mb-0 text-white flex-grow-1";
    title.textContent = video.title;
    const viewsLabel = document.createElement("span");
    viewsLabel.className = "text-muted small ml-3";
    viewsLabel.textContent = `${formatNumber(video.views)} views`;
    titleRow.appendChild(title);
    titleRow.appendChild(viewsLabel);

    const channelRow = document.createElement("div");
    channelRow.className = "d-flex justify-content-between align-items-center text-muted small";
    const channel = document.createElement("span");
    channel.textContent = video.channel;
    const published = document.createElement("span");
    published.textContent = formatTimeAgo(video.published_at);
    channelRow.appendChild(channel);
    channelRow.appendChild(published);

    const metricsRow = document.createElement("div");
    metricsRow.className = "d-flex justify-content-between align-items-center mt-3";
    const velocity = document.createElement("div");
    velocity.className = "metric-chip";
    velocity.textContent = `${formatNumber(video.views_per_hour)} views/hr`;
    const alertBadge = document.createElement("span");
    alertBadge.className = "metric-badge";
    alertBadge.textContent = video.alert ? "🔥 High velocity" : "Steady";
    metricsRow.appendChild(velocity);
    metricsRow.appendChild(alertBadge);

    const ctaRow = document.createElement("div");
    ctaRow.className = "d-flex align-items-center mt-3";
    const linkBtn = document.createElement("a");
    linkBtn.className = "btn btn-sm btn-outline-light";
    linkBtn.href = video.video_url || "#";
    linkBtn.target = "_blank";
    linkBtn.rel = "noopener noreferrer";
    linkBtn.textContent = "Voir sur YouTube";
    ctaRow.appendChild(linkBtn);

    cardBody.appendChild(titleRow);
    cardBody.appendChild(channelRow);
    cardBody.appendChild(metricsRow);
    cardBody.appendChild(ctaRow);

    card.appendChild(thumb);
    card.appendChild(cardBody);
    col.appendChild(card);
    return col;
  }

  function renderVideos() {
    if (!dom.videoGrid) return;
    dom.videoGrid.innerHTML = "";
    state.videos.forEach((video) => {
      dom.videoGrid.appendChild(renderVideoCard(video));
    });
  }

  function renderAlertFeed(listEl, alerts) {
    if (!listEl) return;
    listEl.innerHTML = "";
    alerts.forEach((alert) => {
      const item = document.createElement("li");
      item.className = "list-group-item alert-feed-item";
      const title = document.createElement("div");
      title.className = "font-weight-bold text-white";
      title.textContent = `${alert.title}`;
      const meta = document.createElement("div");
      meta.className = "small text-muted d-flex justify-content-between align-items-center";
      const channel = document.createElement("span");
      channel.textContent = alert.channel;
      const metric = document.createElement("span");
      metric.className = "text-danger font-weight-bold";
      metric.textContent = `${formatNumber(alert.views_per_hour)} /hr`;
      meta.appendChild(channel);
      meta.appendChild(metric);
      item.appendChild(title);
      item.appendChild(meta);
      listEl.appendChild(item);
    });
  }

  function renderAlertPanel() {
    if (!dom.alertPanelList) return;
    dom.alertPanelList.innerHTML = "";
    state.alerts.forEach((alert) => {
      const row = document.createElement("div");
      row.className = "alert-panel-row";
      const left = document.createElement("div");
      left.className = "d-flex flex-column";
      const title = document.createElement("span");
      title.className = "text-white";
      title.textContent = alert.title;
      const meta = document.createElement("span");
      meta.className = "small text-muted";
      meta.textContent = `${alert.channel} • ${formatTimeAgo(alert.published_at)}`;
      left.appendChild(title);
      left.appendChild(meta);
      const metric = document.createElement("div");
      metric.className = "alert-panel-metric";
      metric.textContent = `${formatNumber(alert.views_per_hour)} /hr`;
      row.appendChild(left);
      row.appendChild(metric);
      dom.alertPanelList.appendChild(row);
    });
  }

  function updateCounts() {
    const alertCount = state.alerts.length;
    if (dom.alertCountBadge) dom.alertCountBadge.textContent = alertCount;
    if (dom.alertFeedCount) dom.alertFeedCount.textContent = alertCount;
    if (dom.alertEmpty) dom.alertEmpty.classList.toggle("d-none", alertCount > 0);
  }

  function toggleAlertPanel(forceOpen) {
    if (!dom.alertPanel) return;
    const shouldOpen =
      typeof forceOpen === "boolean" ? forceOpen : !dom.alertPanel.classList.contains("open");
    dom.alertPanel.classList.toggle("open", shouldOpen);
  }

  function wireEvents() {
    if (dom.alertPanelToggle) {
      dom.alertPanelToggle.addEventListener("click", () => toggleAlertPanel());
    }
    if (dom.alertPanelClose) {
      dom.alertPanelClose.addEventListener("click", () => toggleAlertPanel(false));
    }
    document.addEventListener("keyup", (event) => {
      if (event.key === "Escape") toggleAlertPanel(false);
    });
    if (dom.passwordToggle && dom.passwordField) {
      dom.passwordToggle.addEventListener("click", () => {
        const inputType = dom.passwordField.getAttribute("type") === "password" ? "text" : "password";
        dom.passwordField.setAttribute("type", inputType);
        dom.passwordToggle.classList.toggle("fa-eye");
        dom.passwordToggle.classList.toggle("fa-eye-slash");
      });
    }
  }

  function updateTimestamp() {
    if (!dom.lastRefreshed) return;
    const now = new Date();
    const formatted = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    dom.lastRefreshed.textContent = `Refreshed at ${formatted}`;
  }

  function renderDashboard() {
    renderVideos();
    renderAlertFeed(dom.alertList, state.alerts);
    renderAlertPanel();
    updateCounts();
    updateTimestamp();
  }

  function showFeedback(message, variant) {
    if (!dom.feedback) return;
    if (!message) {
      dom.feedback.classList.add("d-none");
      dom.feedback.textContent = "";
      dom.feedback.classList.remove("alert-danger", "alert-success", "alert-info");
      return;
    }
    const intent = variant || "danger";
    dom.feedback.classList.remove("d-none", "alert-danger", "alert-success", "alert-info");
    dom.feedback.classList.add(`alert-${intent}`);
    dom.feedback.textContent = message;
  }

  function showToast(message, variant) {
    if (!dom.toastContainer || !message) return;
    const intent = variant || "info";
    const toastId = `toast-${Date.now()}`;
    const toast = document.createElement("div");
    toast.className = `toast align-items-center text-white bg-${intent} border-0`;
    toast.setAttribute("role", "alert");
    toast.setAttribute("aria-live", "assertive");
    toast.setAttribute("aria-atomic", "true");
    toast.dataset.delay = "3000";
    toast.id = toastId;
    toast.innerHTML = `
      <div class="d-flex">
        <div class="toast-body">${message}</div>
        <button type="button" class="ml-2 mb-1 close text-white" data-dismiss="toast" aria-label="Close">
          <span aria-hidden="true">&times;</span>
        </button>
      </div>
    `;
    dom.toastContainer.appendChild(toast);
    // @ts-ignore bootstrap toast
    $(toast).toast({ delay: 3000 });
    // @ts-ignore bootstrap toast
    $(toast).toast("show");
    toast.addEventListener("hidden.bs.toast", () => toast.remove());
  }

  function setLoading(isLoading) {
    if (!dom.loginForm) return;
    const formControls = dom.loginForm.querySelectorAll("input, button, a");
    formControls.forEach((el) => {
      if (isLoading) {
        el.setAttribute("disabled", "true");
      } else {
        el.removeAttribute("disabled");
      }
    });
    if (dom.submitButton) dom.submitButton.classList.toggle("disabled", isLoading);
    if (dom.loader) dom.loader.classList.toggle("d-none", !isLoading);
  }

  function persistSession(session) {
    if (!session || !session.access_token || !session.refresh_token) return;
    try {
      localStorage.setItem(
        "supabase.auth.session",
        JSON.stringify({
          access_token: session.access_token,
          refresh_token: session.refresh_token,
        })
      );
    } catch (e) {
      console.warn("Unable to persist auth session", e);
    }
  }

  function persistLocalSession(identifier) {
    try {
      localStorage.setItem(LOCAL_SESSION_KEY, JSON.stringify({ user: identifier, createdAt: Date.now() }));
    } catch (e) {
      console.warn("Unable to persist local session", e);
    }
  }

  function hasLocalSession() {
    try {
      return Boolean(localStorage.getItem(LOCAL_SESSION_KEY));
    } catch {
      return false;
    }
  }

  async function restorePersistedSession() {
    if (!supabaseClient) return;
    try {
      const savedSession = localStorage.getItem("supabase.auth.session");
      if (!savedSession) return;
      const parsed = JSON.parse(savedSession);
      if (parsed && parsed.access_token && parsed.refresh_token) {
        await supabaseClient.auth.setSession({
          access_token: parsed.access_token,
          refresh_token: parsed.refresh_token,
        });
      }
    } catch (e) {
      console.warn("Unable to restore saved session", e);
    }
  }

  async function getSupabaseSession() {
    if (!supabaseClient) return null;
    const sessionResponse = await supabaseClient.auth.getSession();
    if (sessionResponse.error) {
      showFeedback(sessionResponse.error.message || "Unable to check session state.");
      return null;
    }
    return sessionResponse.data && sessionResponse.data.session ? sessionResponse.data.session : null;
  }

  async function guardAccess() {
    if (!supabaseClient && !hasLocalSession()) {
      showFeedback("Client Supabase indisponible.");
      setShell("login");
      return false;
    }

    await restorePersistedSession();
    const session = await getSupabaseSession();
    if (session && session.access_token) {
      setShell("dashboard");
      return true;
    }

    if (hasLocalSession()) {
      setShell("dashboard");
      return true;
    }

    setShell("login");
    return false;
  }

  async function handleLogin(event) {
    event.preventDefault();
    if (!dom.usernameField || !dom.passwordField) return;

    const identifier = dom.usernameField.value.trim();
    const password = dom.passwordField.value.trim();
    const adminUser = authConfig.adminUser || "";
    const adminPassword = authConfig.adminPassword || "";

    if (!identifier || !password) {
      showFeedback("Merci de saisir vos identifiants.");
      return;
    }

    const matchesAdmin = adminUser && adminPassword && identifier === adminUser && password === adminPassword;

    showFeedback("", "");
    setLoading(true);

    try {
      if (matchesAdmin) {
        persistLocalSession(identifier);
        showToast("Connexion réussie.", "success");
        setShell("dashboard");
        await loadDashboard();
        return;
      }

      if (!supabaseClient) {
        showFeedback("Supabase client is not available.");
        return;
      }

      const response = await supabaseClient.auth.signInWithPassword({
        email: identifier,
        password: password,
      });

      if (response.error) {
        showFeedback(response.error.message || "Identifiants invalides.");
        return;
      }

      if (response.data && response.data.session) {
        persistSession(response.data.session);
        showToast("Connexion réussie.", "success");
        setShell("dashboard");
        await loadDashboard();
      } else {
        showFeedback("Aucune session renvoyée. Merci de réessayer.");
      }
    } catch (error) {
      showFeedback(error.message || "Unexpected error during sign-in.");
    } finally {
      setLoading(false);
    }
  }

  async function loadDashboard() {
    setShell("dashboard");
    setStatus("Chargement des vidéos en cours…", "info");
    wireEvents();

    let videos = [];
    let source = "Supabase";

    try {
      videos = await fetchVideosFromSupabase();
      if (!videos.length) {
        setStatus("Aucune vidéo Supabase. Affichage des données de secours.", "warning");
        videos = fallbackVideos;
        source = "fallback";
      } else {
        clearStatus();
      }
    } catch (error) {
      console.error("Failed to load videos from Supabase", error);
      setStatus("Supabase request failed; showing cached sample data.", "warning");
      videos = fallbackVideos;
      source = "fallback";
    }

    const normalized = normalizeVideos(videos);
    updateState(normalized, source);
    renderDashboard();
    state.dashboardLoaded = true;
  }

  async function initAuthFlow() {
    if (dom.loginForm) {
      dom.loginForm.addEventListener("submit", handleLogin);
    }
    const allowed = await guardAccess();
    if (allowed) {
      await loadDashboard();
    }
  }

  function init() {
    wireEvents();
    initAuthFlow().catch((error) => {
      showFeedback(error.message || "Failed to initialize authentication.");
    });
  }

  init();
})();
