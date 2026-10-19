import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnalyticsClient } from '../src/analytics.js';
import { buildConsentUrl, createTokenProvider } from '../src/oauth.js';

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('the analytics client asks for peak and average concurrent viewers of one video', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), init });
    return jsonResponse({
      columnHeaders: [{ name: 'averageConcurrentViewers' }, { name: 'peakConcurrentViewers' }],
      rows: [[37.4, 52]],
    });
  };
  const tokenProvider = { getAccessToken: async () => 'tok' };
  const client = createAnalyticsClient({ tokenProvider, fetchImpl });

  const totals = await client.getLivestreamTotals({
    channelId: 'UCchan',
    videoId: 'vid00000001',
    startDate: '2026-10-18',
    endDate: '2026-10-20',
  });

  assert.deepEqual(totals, { averageConcurrentViewers: 37, peakConcurrentViewers: 52 });
  const { url, init } = calls[0];
  assert.equal(url.origin + url.pathname, 'https://youtubeanalytics.googleapis.com/v2/reports');
  assert.equal(url.searchParams.get('ids'), 'channel==UCchan');
  assert.equal(url.searchParams.get('filters'), 'video==vid00000001');
  assert.equal(url.searchParams.get('metrics'), 'averageConcurrentViewers,peakConcurrentViewers');
  assert.equal(init.headers.authorization, 'Bearer tok');
});

test('no rows means no Analytics data yet', async () => {
  const client = createAnalyticsClient({
    tokenProvider: { getAccessToken: async () => 'tok' },
    fetchImpl: async () => jsonResponse({ columnHeaders: [], rows: undefined }),
  });
  assert.equal(
    await client.getLivestreamTotals({ channelId: 'c', videoId: 'v', startDate: '2026-10-18', endDate: '2026-10-19' }),
    null,
  );
});

test('the token provider caches the access token until it nearly expires', async () => {
  let clock = 0;
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    return jsonResponse({ access_token: `t${requests}`, expires_in: 3600 });
  };
  const provider = createTokenProvider({ clientId: 'id', clientSecret: 'secret', refreshToken: 'r', fetchImpl, now: () => clock });

  assert.equal(await provider.getAccessToken(), 't1');
  clock += 1000;
  assert.equal(await provider.getAccessToken(), 't1');
  clock += 3600 * 1000;
  assert.equal(await provider.getAccessToken(), 't2');
  assert.equal(requests, 2);
});

test('the consent URL requests offline access for the analytics scope', () => {
  const url = new URL(buildConsentUrl({ clientId: 'id', redirectUri: 'http://localhost:8787/oauth2callback' }));
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/yt-analytics.readonly');
});
