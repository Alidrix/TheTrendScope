(function () {
  "use strict";

  const ALERT_THRESHOLD = 500000;
  const fallbackVideos = [
    {
      id: "fallback-1",
      title: "AI trailer rewrites break the internet",
      channel: "Creator Lab",
      thumbnail_url: "https://images.unsplash.com/photo-1498050108023-c5249f4df085?auto=format&fit=crop&w=900&q=60",
      views: 9820000,
      views_per_hour: 742000,
      published_at: "2024-08-16T13:00:00Z",
    },
    {
      id: "fallback-2",
      title: "24h speedrun of the world’s hardest puzzle",
      channel: "Puzzle Forge",
      thumbnail_url: "https://images.unsplash.com/photo-1522199710521-72d69614c702?auto=format&fit=crop&w=900&q=60",
      views: 4512000,
      views_per_hour: 529000,
      published_at: "2024-08-16T09:15:00Z",
    },
    {
      id: "fallback-3",
      title: "Live: breaking tech earnings",
      channel: "MarketStream",
      thumbnail_url: "https://images.unsplash.com/photo-1556761175-5973dc0f32e7?auto=format&fit=crop&w=900&q=60",
      views: 1210000,
      views_per_hour: 312000,
      published_at: "2024-08-16T08:00:00Z",
    },
    {
      id: "fallback-4",
      title: "How to film cinematic drone shots",
      channel: "Skyline Studio",
      thumbnail_url: "https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=900&q=60",
      views: 890000,
      views_per_hour: 221000,
      published_at: "2024-08-16T07:30:00Z",
    },
  ];

  const dom = {
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
  };

  const supabaseUrl = window.SUPABASE_URL;
  const supabaseAnonKey = window.SUPABASE_ANON_KEY;
  const supabaseClient = window.supabase && supabaseUrl && supabaseAnonKey
    ? window.supabase.createClient(supabaseUrl, supabaseAnonKey)
    : null;

  const state = {
    videos: [],
    alerts: [],
    source: "",
  };

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
    dom.status.classList.remove("d-none", "alert-info", "alert-warning", "alert-danger");
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
      return {
        id: video.id || `video-${index}`,
        title: video.title || video.name || "Untitled video",
        channel: video.channel || video.channel_name || video.channelTitle || "Unknown channel",
        thumbnail_url: video.thumbnail_url || video.thumbnail || video.thumbnailUrl || "",
        views: Number(video.views || video.total_views || 0),
        views_per_hour: viewsPerHour,
        published_at: video.published_at || video.publishedAt || video.created_at || "",
        alert: alertFlag,
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
      .from("videos")
      .select(
        "id,title,channel,channel_name,thumbnail_url,views,views_per_hour,published_at,alert"
      )
      .order("views_per_hour", { ascending: false });

    if (error) throw error;
    return data || [];
  }

  function renderVideoCard(video) {
    const col = document.createElement("div");
    col.className = "col-md-6 col-xl-4 mb-4";

    const card = document.createElement("div");
    card.className = "card video-card shadow-sm h-100";
    if (video.alert) card.classList.add("video-card-alert");

    const thumb = document.createElement("div");
    thumb.className = "video-thumb";
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

    cardBody.appendChild(titleRow);
    cardBody.appendChild(channelRow);
    cardBody.appendChild(metricsRow);

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

  async function init() {
    setStatus("Loading videos from Supabase…", "info");
    wireEvents();

    let videos = [];
    let source = "Supabase";

    try {
      videos = await fetchVideosFromSupabase();
      if (!videos.length) {
        setStatus("No Supabase rows returned. Showing fallback data.", "warning");
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
  }

  init();
})();
