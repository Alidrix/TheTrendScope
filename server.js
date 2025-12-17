const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

loadEnv();

const PORT = process.env.PORT || 4443;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const ADMIN_USER = process.env.ADMIN_USER || 'zakamon';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changemeStrong16!';

const DATA_PATH = path.join(__dirname, 'data', 'store.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const categoryMap = {
  nourriture: 26,
  voiture: 2,
  business: 28,
  drôle: 23,
  influenceurs: 22,
  gaming: 20,
  sport: 17,
  musique: 10
};

const languageRegion = { fr: 'FR', en: 'US', es: 'ES' };

let store = loadStore();
const sessions = new Map();
let store = loadStore();
ensureDefaultAdmin();
hydrateFromSupabase();

function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf-8');
  raw.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const [key, ...rest] = trimmed.split('=');
    const value = rest.join('=');
    if (!process.env[key]) process.env[key] = value;
  });
}

function loadStore() {
  try {
    if (fs.existsSync(DATA_PATH)) {
      return JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
    }
  } catch (err) {
    console.error('Impossible de charger le store local', err);
  }
  return { videos: [], history: [], notifications: [] };
  return { videos: [], history: [], notifications: [], admins: [] };
}

function saveStore() {
  try {
    fs.writeFileSync(DATA_PATH, JSON.stringify(store, null, 2));
  } catch (err) {
    console.error('Erreur de sauvegarde locale', err);
  }
}

function ensureDefaultAdmin() {
  const exists = store.admins.find((a) => a.username === ADMIN_USER);
  if (!exists) {
    store.admins.push({ username: ADMIN_USER, password: ADMIN_PASSWORD });
    saveStore();
  }
}

async function hydrateFromSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    const videos = await getSupabaseTable('videos', 'select=*');
    if (Array.isArray(videos) && videos.length) {
      store.videos = videos;
    }
    const history = await getSupabaseTable('video_history', 'select=video_id,view_count,like_count,recorded_at');
    if (Array.isArray(history) && history.length) {
      store.history = history;
    }
    saveStore();
  } catch (err) {
    console.error('Hydratation Supabase impossible', err);
  }
}

function respondJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type'
    'Access-Control-Allow-Headers': 'Content-Type, x-session-token'
  });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 5e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        resolve({});
      }
    });
  });
}

function requireAuth(req, res) {
  const token = req.headers['x-session-token'];
  if (!token || !sessions.has(token)) {
    respondJson(res, 401, { error: 'Authentification requise' });
    return false;
  }
  return true;
}

async function checkAdminCredentials(username, password) {
  if (!username || !password) return false;
  const local = store.admins.find((a) => a.username === username && a.password === password);
  if (local) return true;
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const params = new url.URLSearchParams({
        select: 'id,username',
        username: `eq.${username}`,
        password: `eq.${password}`,
        limit: '1'
      });
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/admins?${params.toString()}`, {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
        }
      });
      if (!resp.ok) return false;
      const data = await resp.json();
      return Array.isArray(data) && data.length > 0;
    } catch (err) {
      console.error('Erreur Supabase (admins)', err);
    }
  }
  return false;
}

function serveStatic(req, res, pathname) {
  const filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) return false;
  if (!fs.existsSync(filePath)) return false;
  const ext = path.extname(filePath).toLowerCase();
  const typeMap = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml'
  };
  const contentType = typeMap[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

function parseISODuration(iso) {
  const match = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || '');
  if (!match) return 0;
  const [, h, m, s] = match;
  return (Number(h || 0) * 3600) + (Number(m || 0) * 60) + Number(s || 0);
}

function computeVelocity(viewCount, publishedAt) {
  const publishedMs = new Date(publishedAt || Date.now()).getTime();
  const diff = Date.now() - (Number.isNaN(publishedMs) ? Date.now() : publishedMs);
  const hours = Math.max(diff / 3600000, 1);
  return viewCount / hours;
}

async function fetchTrending({ country = 'FR', category = '', language = 'fr', maxResults = 12 }) {
  if (!YOUTUBE_API_KEY) {
    throw new Error('YOUTUBE_API_KEY manquant');
  }
  const regionCode = country || languageRegion[language] || 'FR';
  const categoryId = categoryMap[category];
  const apiUrl = new url.URL('https://www.googleapis.com/youtube/v3/videos');
  apiUrl.searchParams.set('part', 'snippet,statistics,contentDetails');
  apiUrl.searchParams.set('chart', 'mostPopular');
  apiUrl.searchParams.set('regionCode', regionCode);
  apiUrl.searchParams.set('maxResults', String(Math.min(Math.max(maxResults, 1), 25)));
  if (categoryId) apiUrl.searchParams.set('videoCategoryId', String(categoryId));
  const resp = await fetch(apiUrl.toString() + `&key=${YOUTUBE_API_KEY}`);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`YouTube API: ${resp.status} ${text}`);
  }
  const data = await resp.json();
  const items = data.items || [];
  return items.map((item) => {
    const durationSeconds = parseISODuration(item.contentDetails?.duration);
    const viewCount = Number(item.statistics?.viewCount || 0);
    const likeCount = Number(item.statistics?.likeCount || 0);
    return {
      id: item.id,
      title: item.snippet?.title || 'Sans titre',
      description: item.snippet?.description || '',
      country: regionCode,
      category: category || 'general',
      view_count: viewCount,
      like_count: likeCount,
      published_at: item.snippet?.publishedAt,
      duration_seconds: durationSeconds,
      is_short: durationSeconds <= 60,
      velocity_per_hour: computeVelocity(viewCount, item.snippet?.publishedAt),
      used: false,
      note: '',
      thumbnail_url: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url,
      refreshed_at: new Date().toISOString(),
      channel_title: item.snippet?.channelTitle || ''
    };
  });
}

async function upsertVideosSupabase(records) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !records.length) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/videos`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates'
      },
      body: JSON.stringify(records)
    });
  } catch (err) {
    console.error('Erreur sync Supabase (videos)', err);
  }
}

async function insertHistorySupabase(entries) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !entries.length) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/video_history`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(entries)
    });
  } catch (err) {
    console.error('Erreur sync Supabase (history)', err);
  }
}

async function getSupabaseTable(table, params = '') {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
      }
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch (err) {
    console.error('Erreur récupération Supabase', err);
    return null;
  }
}

function recordHistory(video) {
  const entry = {
    id: crypto.randomUUID(),
    video_id: video.id,
    view_count: video.view_count,
    like_count: video.like_count,
    recorded_at: new Date().toISOString()
  };
  store.history.unshift(entry);
  store.history = store.history.slice(0, 200);
  insertHistorySupabase([entry]);
}

async function refreshStatsForIds(ids) {
  if (!YOUTUBE_API_KEY || !ids.length) return [];
  const batches = [];
  for (let i = 0; i < ids.length; i += 40) {
    batches.push(ids.slice(i, i + 40));
  }
  const results = [];
  for (const batch of batches) {
    const apiUrl = new url.URL('https://www.googleapis.com/youtube/v3/videos');
    apiUrl.searchParams.set('part', 'statistics,contentDetails,snippet');
    apiUrl.searchParams.set('id', batch.join(','));
    const resp = await fetch(apiUrl.toString() + `&key=${YOUTUBE_API_KEY}`);
    if (!resp.ok) continue;
    const data = await resp.json();
    results.push(...(data.items || []));
  }
  return results.map((item) => {
    const durationSeconds = parseISODuration(item.contentDetails?.duration);
    const viewCount = Number(item.statistics?.viewCount || 0);
    const likeCount = Number(item.statistics?.likeCount || 0);
    return {
      id: item.id,
      duration_seconds: durationSeconds,
      view_count: viewCount,
      like_count: likeCount,
      velocity_per_hour: computeVelocity(viewCount, item.snippet?.publishedAt),
      thumbnail_url: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url,
      channel_title: item.snippet?.channelTitle || ''
    };
  });
}

function exportCSV(history) {
  const header = 'video_id,view_count,like_count,recorded_at\n';
  const rows = history
    .map((h) => `${h.video_id},${h.view_count},${h.like_count},${h.recorded_at}`)
    .join('\n');
  return header + rows;
}

const server = http.createServer(async (req, res) => {
  const { pathname, query } = url.parse(req.url, true);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Headers': 'Content-Type, x-session-token',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
    });
    res.end();
    return;
  }

  if (serveStatic(req, res, pathname)) return;

  if (pathname === '/api/login' && req.method === 'POST') {
    const body = await parseBody(req);
    const valid = await checkAdminCredentials(body.username, body.password);
    if (!valid) return respondJson(res, 401, { error: 'Identifiants invalides' });
    const token = crypto.randomUUID();
    sessions.set(token, { username: body.username, createdAt: Date.now() });
    return respondJson(res, 200, { token });
  }

  if (pathname === '/api/videos' && req.method === 'GET') {
    const videos = [...store.videos].sort((a, b) => (b.velocity_per_hour || 0) - (a.velocity_per_hour || 0));
    return respondJson(res, 200, { videos });
  }

  if (pathname === '/api/refresh' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    const body = await parseBody(req);
    try {
      const freshVideos = await fetchTrending(body);
      const threshold = Number(body.alertThreshold || 12000);
      const notifications = [];
      freshVideos.forEach((video) => {
        const existing = store.videos.find((v) => v.id === video.id);
        const merged = { ...(existing || {}), ...video, used: existing?.used || false, note: existing?.note || '' };
        const idx = store.videos.findIndex((v) => v.id === video.id);
        if (idx >= 0) store.videos[idx] = merged; else store.videos.push(merged);
        recordHistory(merged);
        if (merged.velocity_per_hour >= threshold) {
          notifications.push({
            title: `${merged.title.substring(0, 64)}…`,
            message: `${Math.round(merged.velocity_per_hour).toLocaleString()} vues/h (${merged.country})`,
            level: merged.velocity_per_hour > threshold * 1.5 ? 'high' : 'info'
          });
        }
      });
      store.notifications = [...notifications, ...store.notifications].slice(0, 30);
      saveStore();
      upsertVideosSupabase(freshVideos);
      return respondJson(res, 200, { videos: store.videos, notifications });
    } catch (err) {
      console.error(err);
      return respondJson(res, 400, { error: err.message });
    }
  }

  if (pathname === '/api/refresh-stats' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    try {
      const updates = await refreshStatsForIds(store.videos.map((v) => v.id));
      updates.forEach((u) => {
        const idx = store.videos.findIndex((v) => v.id === u.id);
        if (idx >= 0) {
          store.videos[idx] = { ...store.videos[idx], ...u };
          recordHistory(store.videos[idx]);
        }
      });
      saveStore();
      upsertVideosSupabase(store.videos);
      return respondJson(res, 200, { videos: store.videos });
    } catch (err) {
      console.error(err);
      return respondJson(res, 400, { error: 'Impossible de rafraîchir' });
    }
  }

  if (pathname.startsWith('/api/videos/') && pathname.endsWith('/note') && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    const id = pathname.split('/')[3];
    const body = await parseBody(req);
    const video = store.videos.find((v) => v.id === id);
    if (!video) return respondJson(res, 404, { error: 'Vidéo introuvable' });
    video.note = body.note || '';
    saveStore();
    upsertVideosSupabase([video]);
    return respondJson(res, 200, { success: true });
  }

  if (pathname.startsWith('/api/videos/') && pathname.endsWith('/mark-used') && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    const id = pathname.split('/')[3];
    const video = store.videos.find((v) => v.id === id);
    if (!video) return respondJson(res, 404, { error: 'Vidéo introuvable' });
    video.used = true;
    recordHistory(video);
    saveStore();
    upsertVideosSupabase([video]);
    return respondJson(res, 200, { success: true });
  }

  if (pathname.startsWith('/api/videos/') && pathname.endsWith('/refresh') && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    const id = pathname.split('/')[3];
    try {
      const [update] = await refreshStatsForIds([id]);
      const idx = store.videos.findIndex((v) => v.id === id);
      if (idx >= 0 && update) {
        store.videos[idx] = { ...store.videos[idx], ...update };
        recordHistory(store.videos[idx]);
        saveStore();
        upsertVideosSupabase([store.videos[idx]]);
      }
      return respondJson(res, 200, { success: true });
    } catch (err) {
      console.error(err);
      return respondJson(res, 400, { error: 'Mise à jour impossible' });
    }
  }

  if (pathname === '/api/history' && req.method === 'GET') {
    const history = [...store.history].sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at));
    return respondJson(res, 200, { history });
  }

  if (pathname === '/api/notifications' && req.method === 'GET') {
    return respondJson(res, 200, { notifications: store.notifications });
  }

  if (pathname === '/api/export' && req.method === 'GET') {
    const format = query.format === 'csv' ? 'csv' : 'json';
    const filename = `history.${format}`;
    const payload = format === 'csv' ? exportCSV(store.history) : JSON.stringify(store.history, null, 2);
    res.writeHead(200, {
      'Content-Type': format === 'csv' ? 'text/csv' : 'application/json',
      'Content-Disposition': `attachment; filename="${filename}"`
    });
    res.end(payload);
    return;
  }

  respondJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`Trend Scope prêt sur http://localhost:${PORT}`);
});
