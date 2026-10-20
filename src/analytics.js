const REPORTS_URL = 'https://youtubeanalytics.googleapis.com/v2/reports';

// Video-level peak and average concurrent viewers from the YouTube Analytics API.
// Requires OAuth as the channel owner or a manager; returns null when no data is available yet.
export function createAnalyticsClient({ tokenProvider, fetchImpl = fetch }) {
  return {
    async getLivestreamTotals({ channelId, videoId, startDate, endDate }) {
      const url = new URL(REPORTS_URL);
      url.search = new URLSearchParams({
        ids: `channel==${channelId}`,
        filters: `video==${videoId}`,
        startDate,
        endDate,
        metrics: 'averageConcurrentViewers,peakConcurrentViewers',
      }).toString();
      const token = await tokenProvider.getAccessToken();
      const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        throw new Error(`YouTube Analytics failed with ${res.status}: ${body}`);
      }
      const data = await res.json();
      const row = data.rows?.[0];
      if (!row) return null;
      const column = (name) => data.columnHeaders.findIndex((header) => header.name === name);
      return {
        averageConcurrentViewers: Math.round(row[column('averageConcurrentViewers')]),
        peakConcurrentViewers: Math.round(row[column('peakConcurrentViewers')]),
      };
    },
  };
}
