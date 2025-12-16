import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  JWT_CURRENT_KEY,
  JWT_STANDBY_KEY,
  JWT_LEGACY_SECRET,
  YOUTUBE_API_KEY,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont obligatoires.');
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const JWT_SECRETS = [JWT_CURRENT_KEY, JWT_STANDBY_KEY, JWT_LEGACY_SECRET].filter(Boolean);

const signToken = (payload) => {
  const secret = JWT_SECRETS[0];
  if (!secret) throw new Error('Aucune clé JWT définie.');
  return jwt.sign(payload, secret, { expiresIn: '2h' });
};

const verifyToken = (token) => {
  for (const secret of JWT_SECRETS) {
    try {
      return jwt.verify(token, secret);
    } catch (err) {
      continue; // essaie la clé suivante
    }
  }
  throw new Error('Token invalide');
};

const authMiddleware = (req, res, next) => {
  const token = req.headers['x-admin-token'];
  if (!token) return res.status(401).json({ error: 'Token requis' });
  try {
    req.admin = verifyToken(token);
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Token invalide' });
  }
};

const parseDurationToSeconds = (isoDuration = '') => {
  const regex = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/;
  const [, hours, minutes, seconds] = isoDuration.match(regex) || [];
  return (Number(hours || 0) * 3600) + (Number(minutes || 0) * 60) + Number(seconds || 0);
};

const categoryMap = {
  1: 'Film & Animation',
  2: 'Autos & Vehicles',
  10: 'Music',
  15: 'Pets & Animals',
  17: 'Sports',
  20: 'Gaming',
  22: 'People & Blogs',
  23: 'Comedy',
  24: 'Entertainment',
  25: 'News & Politics',
  26: 'Howto & Style',
  27: 'Education',
  28: 'Science & Technology',
  30: 'Movies',
  43: 'Shows',
};

const computeVelocity = (viewCount, publishedAt) => {
  const publishedDate = new Date(publishedAt);
  const hoursSincePublished = Math.max((Date.now() - publishedDate.getTime()) / 3600000, 0.01);
  return Number(viewCount) / hoursSincePublished;
};

const fetchHealth = async () => {
  const health = { supabase: false, jwt: false };
  try {
    const { error } = await supabase.from('admins').select('id').limit(1);
    health.supabase = !error;
  } catch (err) {
    health.supabase = false;
  }
  try {
    const token = signToken({ probe: true });
    verifyToken(token);
    health.jwt = true;
  } catch (err) {
    health.jwt = false;
  }
  return health;
};

app.get('/api/health', async (_req, res) => {
  const health = await fetchHealth();
  return res.json(health);
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Identifiants requis' });

  try {
    const { data, error } = await supabase
      .from('admins')
      .select('username, password')
      .eq('username', username)
      .maybeSingle();

    if (error) return res.status(500).json({ error: 'Erreur Supabase' });
    if (!data || data.password !== password) return res.status(401).json({ error: 'Identifiants invalides' });

    const token = signToken({ username });
    const health = await fetchHealth();
    return res.json({ token, user: { username }, health });
  } catch (err) {
    return res.status(500).json({ error: 'Connexion impossible' });
  }
});

app.get('/api/videos', authMiddleware, async (req, res) => {
  const { country, category, search, shortOnly } = req.query;
  let query = supabase.from('videos').select('*').order('velocity_per_hour', { ascending: false }).limit(100);

  if (country) query = query.eq('country', country.toUpperCase());
  if (category) query = query.ilike('category', `%${category}%`);
  if (search) query = query.ilike('title', `%${search}%`);
  if (shortOnly === 'true') query = query.eq('is_short', true);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ items: data });
});

app.get('/api/videos/:id/history', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from('video_history')
    .select('view_count, like_count, recorded_at')
    .eq('video_id', id)
    .order('recorded_at', { ascending: false })
    .limit(50);

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ items: data });
});

app.patch('/api/videos/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { note, used } = req.body || {};
  const payload = {};
  if (note !== undefined) payload.note = note;
  if (used !== undefined) payload.used = used;

  const { data, error } = await supabase.from('videos').update(payload).eq('id', id).select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ item: data });
});

app.get('/api/notifications', authMiddleware, async (_req, res) => {
  const { data, error } = await supabase
    .from('videos')
    .select('id, title, velocity_per_hour, country, is_short, refreshed_at, note')
    .order('velocity_per_hour', { ascending: false })
    .limit(20);
  if (error) return res.status(500).json({ error: error.message });

  const now = Date.now();
  const alerts = (data || [])
    .filter((v) => Number(v.velocity_per_hour || 0) >= 5000)
    .map((v) => ({
      id: v.id,
      title: v.title,
      velocity_per_hour: v.velocity_per_hour,
      country: v.country,
      is_short: v.is_short,
      freshness_hours: ((now - new Date(v.refreshed_at).getTime()) / 3600000).toFixed(1),
      note: v.note,
    }));

  return res.json({ items: alerts });
});

app.post('/api/videos/refresh', authMiddleware, async (req, res) => {
  const { country = 'FR', maxResults = 10 } = req.body || {};

  if (!YOUTUBE_API_KEY) {
    return res.status(500).json({ error: 'YOUTUBE_API_KEY manquante dans .env' });
  }

  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part', 'snippet,statistics,contentDetails');
  url.searchParams.set('chart', 'mostPopular');
  url.searchParams.set('regionCode', country.toUpperCase());
  url.searchParams.set('maxResults', Math.min(Number(maxResults) || 10, 25));
  url.searchParams.set('key', YOUTUBE_API_KEY);

  const response = await fetch(url);
  if (!response.ok) {
    return res.status(500).json({ error: 'Appel YouTube échoué' });
  }
  const payload = await response.json();
  const items = payload.items || [];

  const mapped = items.map((video) => {
    const id = video.id;
    const title = video.snippet?.title || 'Vidéo sans titre';
    const description = video.snippet?.description || '';
    const publishedAt = video.snippet?.publishedAt;
    const durationSeconds = parseDurationToSeconds(video.contentDetails?.duration);
    const viewCount = Number(video.statistics?.viewCount || 0);
    const likeCount = Number(video.statistics?.likeCount || 0);
    const velocity = computeVelocity(viewCount, publishedAt);
    const countryCode = country.toUpperCase();
    const categoryId = video.snippet?.categoryId;
    const thumbnail = video.snippet?.thumbnails?.maxres?.url || video.snippet?.thumbnails?.high?.url;

    return {
      id,
      title,
      description,
      country: countryCode,
      category: categoryMap[categoryId] || categoryId || 'Autre',
      view_count: viewCount,
      like_count: likeCount,
      published_at: publishedAt,
      duration_seconds: durationSeconds,
      is_short: durationSeconds <= 60,
      velocity_per_hour: velocity,
      used: false,
      thumbnail_url: thumbnail,
      refreshed_at: new Date().toISOString(),
    };
  });

  if (!mapped.length) return res.json({ inserted: 0, updated: 0 });

  const { data, error } = await supabase.from('videos').upsert(mapped, { onConflict: 'id' }).select('id');
  if (error) return res.status(500).json({ error: error.message });

  const historyRows = mapped.map((v) => ({
    video_id: v.id,
    view_count: v.view_count,
    like_count: v.like_count,
  }));
  await supabase.from('video_history').insert(historyRows);

  return res.json({ inserted: data?.length || 0, country: country.toUpperCase() });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 4443;
app.listen(PORT, () => {
  console.log(`The Trend Scope prêt sur http://localhost:${PORT}`);
});
