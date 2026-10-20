const API_BASE = 'https://www.googleapis.com/youtube/v3';
const MAX_VIDEOS_PER_REQUEST = 50;

// Channel IDs start with "UC"; every channel has an uploads playlist whose ID starts with "UU".
// Listing it costs one quota unit, while search.list costs 100.
export function uploadsPlaylistId(channelId) {
  if (!channelId.startsWith('UC')) throw new Error(`Invalid YouTube channel id: ${channelId}`);
  return `UU${channelId.slice(2)}`;
}

export function normalizeVideo(item) {
  const live = item.liveStreamingDetails ?? {};
  return {
    id: item.id,
    channelId: item.snippet.channelId,
    title: item.snippet.title,
    publishedAt: item.snippet.publishedAt ?? null,
    liveBroadcastContent: item.snippet.liveBroadcastContent ?? 'none',
    scheduledStartTime: live.scheduledStartTime ?? null,
    actualStartTime: live.actualStartTime ?? null,
    actualEndTime: live.actualEndTime ?? null,
    viewCount: item.statistics?.viewCount == null ? null : Number(item.statistics.viewCount),
  };
}

function* chunks(values, size) {
  for (let i = 0; i < values.length; i += size) yield values.slice(i, i + size);
}

export function createYouTubeClient({ apiKey, fetchImpl = fetch }) {
  async function get(resource, params) {
    const url = new URL(`${API_BASE}/${resource}`);
    for (const [name, value] of Object.entries({ ...params, key: apiKey })) {
      url.searchParams.set(name, String(value));
    }
    const res = await fetchImpl(url);
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new Error(`YouTube ${resource} failed with ${res.status}: ${body}`);
    }
    return res.json();
  }

  async function getVideos(ids) {
    const videos = [];
    for (const batch of chunks(ids, MAX_VIDEOS_PER_REQUEST)) {
      const data = await get('videos', {
        part: 'snippet,liveStreamingDetails,statistics',
        id: batch.join(','),
      });
      videos.push(...(data.items ?? []).map(normalizeVideo));
    }
    return videos;
  }

  return {
    getVideos,
    async getChannelUploads(channelId, maxResults = 10) {
      const data = await get('playlistItems', {
        part: 'contentDetails',
        playlistId: uploadsPlaylistId(channelId),
        maxResults,
      });
      return getVideos((data.items ?? []).map((item) => item.contentDetails.videoId));
    },
  };
}
