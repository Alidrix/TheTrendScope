// @ts-nocheck
import { loadEnvFile, getRequiredEnv } from "../config";

const REGIONS = ["FR", "US", "ES"];
const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";

const selectThumbnail = (thumbnails: any) => {
  if (!thumbnails) return "";
  return (
    thumbnails?.maxres?.url ||
    thumbnails?.standard?.url ||
    thumbnails?.high?.url ||
    thumbnails?.medium?.url ||
    thumbnails?.default?.url ||
    ""
  );
};

const parseISODuration = (duration: string) => {
  if (!duration || typeof duration !== "string") return 0;
  const regex =
    /P(?:([0-9]+)Y)?(?:([0-9]+)M)?(?:([0-9]+)W)?(?:([0-9]+)D)?(?:T(?:([0-9]+)H)?(?:([0-9]+)M)?(?:([0-9]+)S)?)?/;
  const matches = duration.match(regex);
  if (!matches) return 0;
  const years = parseInt(matches[1] || "0", 10);
  const months = parseInt(matches[2] || "0", 10);
  const weeks = parseInt(matches[3] || "0", 10);
  const days = parseInt(matches[4] || "0", 10);
  const hours = parseInt(matches[5] || "0", 10);
  const minutes = parseInt(matches[6] || "0", 10);
  const seconds = parseInt(matches[7] || "0", 10);
  const totalDays = years * 365 + months * 30 + weeks * 7 + days;
  return (
    totalDays * 24 * 60 * 60 +
    hours * 60 * 60 +
    minutes * 60 +
    seconds
  );
};

const calculateViewsPerHour = (viewCount: number, publishedAt: string) => {
  const publishedTime = Date.parse(publishedAt);
  if (Number.isNaN(publishedTime) || !viewCount) return 0;
  const hoursLive = Math.max((Date.now() - publishedTime) / 36e5, 1 / 60);
  return Number((viewCount / hoursLive).toFixed(2));
};

const chunk = (items: any[], size: number) => {
  const chunks: any[] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

const buildSupabaseHeaders = (serviceRoleKey: string) => ({
  "Content-Type": "application/json",
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
});

const fetchCategoryTitles = async (
  region: string,
  categoryIds: string[],
  apiKey: string,
) => {
  if (!categoryIds.length) return {};
  const params = new URLSearchParams({
    part: "snippet",
    id: categoryIds.join(","),
    regionCode: region,
    key: apiKey,
  });
  const response = await fetch(
    `${YOUTUBE_API_BASE}/videoCategories?${params.toString()}`,
  );
  if (!response.ok) {
    throw new Error(
      `Unable to fetch category titles for ${region}: ${response.statusText}`,
    );
  }
  const payload = await response.json();
  const mapping: Record<string, string> = {};
  (payload.items || []).forEach((item: any) => {
    if (item?.id && item?.snippet?.title) {
      mapping[item.id] = item.snippet.title;
    }
  });
  return mapping;
};

const fetchTrendingVideos = async (region: string, apiKey: string) => {
  const params = new URLSearchParams({
    part: "id,snippet,contentDetails,statistics",
    chart: "mostPopular",
    maxResults: "20",
    regionCode: region,
    key: apiKey,
  });
  const response = await fetch(`${YOUTUBE_API_BASE}/videos?${params.toString()}`);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch trending videos for ${region}: ${response.status} ${response.statusText}`,
    );
  }
  const payload = await response.json();
  const items = payload.items || [];
  const categoryIds = Array.from(
    new Set(items.map((item: any) => item?.snippet?.categoryId).filter(Boolean)),
  );
  const categoryMap = await fetchCategoryTitles(region, categoryIds, apiKey);

  return items.map((item: any) => {
    const durationSeconds = parseISODuration(item?.contentDetails?.duration);
    const viewCount = Number(item?.statistics?.viewCount || 0);
    return {
      id: item.id,
      title: item?.snippet?.title || "",
      description: item?.snippet?.description || "",
      channel_title: item?.snippet?.channelTitle || "",
      category_id: item?.snippet?.categoryId || "",
      category_title:
        categoryMap[item?.snippet?.categoryId] || "Unknown category",
      region,
      published_at: item?.snippet?.publishedAt || "",
      duration_seconds: durationSeconds,
      is_short: durationSeconds <= 60,
      thumbnail_url: selectThumbnail(item?.snippet?.thumbnails),
      view_count: viewCount,
      like_count: Number(item?.statistics?.likeCount || 0),
      comment_count: Number(item?.statistics?.commentCount || 0),
      views_per_hour: calculateViewsPerHour(
        viewCount,
        item?.snippet?.publishedAt || "",
      ),
    };
  });
};

const fetchExistingVideos = async (videoIds: string[], config: any) => {
  const results: Record<string, any> = {};
  const idChunks = chunk(videoIds, 100);
  for (const idChunk of idChunks) {
    const filter = `in.(${idChunk.map((id) => `"${id}"`).join(",")})`;
    const url = `${config.restUrl}/videos?id=${encodeURIComponent(filter)}`;
    const response = await fetch(url, {
      method: "GET",
      headers: buildSupabaseHeaders(config.serviceRoleKey),
    });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch existing videos: ${response.status} ${response.statusText}`,
      );
    }
    const payload = await response.json();
    (payload || []).forEach((row: any) => {
      if (row.id) {
        results[row.id] = row;
      }
    });
  }
  return results;
};

const videoHasChanged = (existing: any, current: any) => {
  const keysToCompare = [
    "title",
    "channel_title",
    "category_id",
    "category_title",
    "region",
    "published_at",
    "duration_seconds",
    "is_short",
    "thumbnail_url",
    "description",
  ];
  return keysToCompare.some(
    (key) => `${existing[key] ?? ""}` !== `${current[key] ?? ""}`,
  );
};

const upsertVideos = async (videos: any[], existingMap: any, config: any) => {
  const newVideos = videos.filter((video) => !existingMap[video.id]);
  const updatedVideos = videos.filter((video) => {
    const existing = existingMap[video.id];
    if (!existing) return false;
    return videoHasChanged(existing, video);
  });

  const payload = [...newVideos, ...updatedVideos].map((video) => ({
    id: video.id,
    title: video.title,
    channel_title: video.channel_title,
    category_id: video.category_id,
    category_title: video.category_title,
    region: video.region,
    published_at: video.published_at,
    duration_seconds: video.duration_seconds,
    is_short: video.is_short,
    thumbnail_url: video.thumbnail_url,
    description: video.description,
    updated_at: new Date().toISOString(),
  }));

  if (payload.length) {
    const response = await fetch(`${config.restUrl}/videos`, {
      method: "POST",
      headers: {
        ...buildSupabaseHeaders(config.serviceRoleKey),
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(
        `Failed to upsert videos: ${response.status} ${response.statusText} - ${message}`,
      );
    }
  }

  return {
    newCount: newVideos.length,
    updatedCount: updatedVideos.length,
  };
};

const insertStatsSnapshots = async (videos: any[], config: any) => {
  if (!videos.length) return 0;
  const snapshotTime = new Date().toISOString();
  const payload = videos.map((video) => ({
    video_id: video.id,
    view_count: video.view_count,
    like_count: video.like_count,
    comment_count: video.comment_count,
    views_per_hour: video.views_per_hour,
    captured_at: snapshotTime,
  }));

  const response = await fetch(`${config.restUrl}/stats_snapshots`, {
    method: "POST",
    headers: {
      ...buildSupabaseHeaders(config.serviceRoleKey),
      Prefer: "return=minimal",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(
      `Failed to insert stats snapshots: ${response.status} ${response.statusText} - ${message}`,
    );
  }
  return payload.length;
};

export const ingestYouTubeTrending = async () => {
  loadEnvFile();
  const apiKey = getRequiredEnv("YOUTUBE_API_KEY");
  const supabaseUrl = getRequiredEnv("SUPABASE_URL");
  const serviceRoleKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabaseConfig = {
    restUrl: `${supabaseUrl}/rest/v1`,
    serviceRoleKey,
  };

  const regionSummaries: any[] = [];
  const totals = {
    fetched: 0,
    newVideos: 0,
    updatedVideos: 0,
    statsInserted: 0,
  };

  for (const region of REGIONS) {
    const videos = await fetchTrendingVideos(region, apiKey);
    const uniqueMap = new Map<string, any>();
    videos.forEach((video) => {
      if (video.id && !uniqueMap.has(video.id)) {
        uniqueMap.set(video.id, video);
      }
    });
    const uniqueVideos = Array.from(uniqueMap.values());
    const existing = await fetchExistingVideos(
      uniqueVideos.map((video) => video.id),
      supabaseConfig,
    );
    const { newCount, updatedCount } = await upsertVideos(
      uniqueVideos,
      existing,
      supabaseConfig,
    );
    const statsInserted = await insertStatsSnapshots(
      uniqueVideos,
      supabaseConfig,
    );
    const summary = {
      region,
      fetched: uniqueVideos.length,
      newVideos: newCount,
      updatedVideos: updatedCount,
      statsInserted,
    };
    regionSummaries.push(summary);
    totals.fetched += summary.fetched;
    totals.newVideos += summary.newVideos;
    totals.updatedVideos += summary.updatedVideos;
    totals.statsInserted += summary.statsInserted;
  }

  return { regions: regionSummaries, totals };
};
