import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../src/domain.js';
import { createStore } from '../src/store.js';
import { createTracker } from '../src/tracker.js';
import { normalizeVideo, uploadsPlaylistId } from '../src/youtube.js';

const CHANNEL = 'UCexampleChannelId1234567';

function makeVideo(overrides = {}) {
  return {
    id: 'live0000001',
    channelId: CHANNEL,
    title: 'Sunnuntain jumalanpalvelus',
    publishedAt: '2026-10-18T10:00:00Z',
    liveBroadcastContent: 'live',
    scheduledStartTime: '2026-10-18T10:00:00Z',
    actualStartTime: '2026-10-18T10:01:00Z',
    actualEndTime: null,
    concurrentViewers: 40,
    viewCount: 0,
    ...overrides,
  };
}

// Serves a mutable list of videos, like the YouTube API would.
function fakeYouTube(videos) {
  return {
    videos,
    async getChannelUploads() {
      return [...videos.values()];
    },
    async getVideos(ids) {
      return ids.map((id) => videos.get(id)).filter(Boolean);
    },
  };
}

async function setup({ videos = new Map(), analytics = null, start = '2026-10-18T10:00:00Z' } = {}) {
  let clock = new Date(start);
  const sent = [];
  const logs = [];
  const store = await createStore({
    defaults: {
      ...DEFAULT_SETTINGS,
      reportRecipient: 'tilasto@example.com',
      senderEmail: 'lahettaja@example.com',
    },
  });
  const tracker = createTracker({
    config: { youtubeChannelIds: [CHANNEL], publicBaseUrl: 'https://striimi.example.fi' },
    store,
    youtube: fakeYouTube(videos),
    analytics,
    mailer: { async send(message) { sent.push(message); } },
    now: () => clock,
    log: { error: (message) => logs.push(message) },
  });
  return {
    tracker,
    store,
    sent,
    logs,
    setTime(iso) {
      clock = new Date(iso);
    },
  };
}

test('uploadsPlaylistId maps a channel id to its uploads playlist', () => {
  assert.equal(uploadsPlaylistId(CHANNEL), 'UUexampleChannelId1234567');
  assert.throws(() => uploadsPlaylistId('not-a-channel'));
});

test('normalizeVideo converts API strings to numbers and defaults', () => {
  const out = normalizeVideo({
    id: 'x',
    snippet: { channelId: CHANNEL, title: 'T', liveBroadcastContent: 'live' },
    liveStreamingDetails: { concurrentViewers: '17', actualStartTime: '2026-10-18T10:00:00Z' },
    statistics: { viewCount: '99' },
  });
  assert.equal(out.concurrentViewers, 17);
  assert.equal(out.viewCount, 99);
  assert.equal(out.actualEndTime, null);
  assert.equal(normalizeVideo({ id: 'y', snippet: { channelId: CHANNEL, title: 'U' } }).liveBroadcastContent, 'none');
});

test('a live stream is discovered once and sampled on every tick', async () => {
  const videos = new Map([['live0000001', makeVideo()]]);
  const app = await setup({ videos });

  await app.tracker.tick();
  videos.set('live0000001', makeVideo({ concurrentViewers: 55 }));
  app.setTime('2026-10-18T10:01:00Z');
  await app.tracker.tick();

  const event = app.store.getEvent('live0000001');
  assert.equal(event.source, 'youtube');
  assert.equal(event.countingScheme, null);
  assert.deepEqual(event.samples.map((s) => s.viewers), [40, 55]);
  assert.equal(app.store.listEvents().length, 1);
});

test('when a stream ends its end time is recorded and the report is sent once, after the delay', async () => {
  const videos = new Map([['live0000001', makeVideo()]]);
  const app = await setup({ videos });
  await app.tracker.tick();

  videos.set('live0000001', makeVideo({ liveBroadcastContent: 'none', actualEndTime: '2026-10-18T11:00:00Z', concurrentViewers: null, viewCount: 300 }));
  app.setTime('2026-10-18T11:05:00Z');
  await app.tracker.tick();
  assert.equal(app.store.getEvent('live0000001').endsAt, '2026-10-18T11:00:00Z');
  assert.equal(app.sent.length, 0, 'not before the reporting delay has passed');

  // Other events are counted for 7 days after the end, so jump past the storage boundary.
  app.setTime('2026-10-25T11:00:01Z');
  await app.tracker.tick();
  await app.tracker.tick();

  assert.equal(app.sent.length, 1);
  assert.equal(app.sent[0].to, 'tilasto@example.com');
  assert.match(app.sent[0].text, /Samanaikaisia katsojia \(enimmäismäärä\): 40/);
  assert.ok(app.store.getEvent('live0000001').reportSentAt);
});

test('contact emails are kept out of the report email but stay on the form until it is deleted', async () => {
  const videos = new Map([['live0000001', makeVideo()]]);
  const app = await setup({ videos });
  await app.tracker.tick();
  videos.set('live0000001', makeVideo({ liveBroadcastContent: 'none', actualEndTime: '2026-10-18T11:00:00Z', concurrentViewers: null }));
  app.setTime('2026-10-18T11:05:00Z');
  await app.tracker.tick();

  const event = app.store.getEvent('live0000001');
  event.submissions.push({ id: 's1', groupName: 'Ryhmä', watchers: 5, contactEmail: 'joku@example.com', createdAt: '2026-10-18T11:10:00Z' });
  await app.tracker.sendReport(event, new Date('2026-10-19T12:00:00Z'));

  assert.equal(event.submissions[0].contactEmail, 'joku@example.com');
  assert.equal(app.sent.length, 1);
  assert.doesNotMatch(app.sent[0].text, /joku@example\.com/);
  assert.match(app.sent[0].text, /- Ryhmä: 5/);
});

test('resolveVideo only creates events for configured channels', async () => {
  const videos = new Map([
    ['live0000001', makeVideo()],
    ['other000002', makeVideo({ id: 'other000002', channelId: 'UCsomeoneElse000000000000' })],
  ]);
  const app = await setup({ videos });

  assert.equal(await app.tracker.resolveVideo('other000002'), null);
  assert.ok(await app.tracker.resolveVideo('live0000001'));
  assert.equal(app.store.getEvent('other000002'), null);
});

test('a missing report configuration is logged and nothing is marked sent', async () => {
  const videos = new Map([['live0000001', makeVideo()]]);
  const app = await setup({ videos });
  await app.store.updateSettings({ reportRecipient: '' });
  await app.tracker.tick();
  videos.set('live0000001', makeVideo({ liveBroadcastContent: 'none', actualEndTime: '2026-10-18T11:00:00Z', concurrentViewers: null }));
  app.setTime('2026-10-26T12:00:00Z');
  await app.tracker.tick();

  assert.equal(app.sent.length, 0);
  assert.equal(app.store.getEvent('live0000001').reportSentAt, null);
  assert.equal(app.logs.length, 1);
});

test('the report uses Analytics peak and average when available', async () => {
  const videos = new Map([['live0000001', makeVideo()]]);
  const analyticsCalls = [];
  const analytics = {
    async getLivestreamTotals(args) {
      analyticsCalls.push(args);
      return { averageConcurrentViewers: 30, peakConcurrentViewers: 90 };
    },
  };
  const app = await setup({ videos, analytics });
  await app.tracker.tick();
  videos.set('live0000001', makeVideo({ liveBroadcastContent: 'none', actualEndTime: '2026-10-18T11:00:00Z', concurrentViewers: null }));
  app.setTime('2026-10-18T11:05:00Z');
  await app.tracker.tick();

  await app.tracker.sendReport(app.store.getEvent('live0000001'), new Date('2026-10-19T12:00:00Z'));

  assert.equal(analyticsCalls[0].videoId, 'live0000001');
  assert.equal(analyticsCalls[0].channelId, CHANNEL);
  assert.match(app.sent[0].text, /Samanaikaisia katsojia \(enimmäismäärä\): 90/);
  assert.match(app.sent[0].text, /Samanaikaisia katsojia \(keskiarvo\): 30/);
});

test('a failing Analytics call falls back to the sampled values and is logged', async () => {
  const videos = new Map([['live0000001', makeVideo()]]);
  const analytics = {
    async getLivestreamTotals() {
      throw new Error('quota');
    },
  };
  const app = await setup({ videos, analytics });
  await app.tracker.tick();
  videos.set('live0000001', makeVideo({ liveBroadcastContent: 'none', actualEndTime: '2026-10-18T11:00:00Z', concurrentViewers: null }));
  app.setTime('2026-10-18T11:05:00Z');
  await app.tracker.tick();

  await app.tracker.sendReport(app.store.getEvent('live0000001'), new Date('2026-10-19T12:00:00Z'));

  assert.equal(app.sent.length, 1);
  assert.match(app.sent[0].text, /enimmäismäärä\): 40/);
  assert.equal(app.logs.length, 1);
});

test('recording views are counted from the view count at the end of the stream', async () => {
  const videos = new Map([['live0000001', makeVideo({ viewCount: 500 })]]);
  const app = await setup({ videos });
  await app.tracker.tick();
  videos.set('live0000001', makeVideo({ liveBroadcastContent: 'none', actualEndTime: '2026-10-18T11:00:00Z', concurrentViewers: null, viewCount: 520 }));
  app.setTime('2026-10-18T11:05:00Z');
  await app.tracker.tick();
  assert.equal(app.store.getEvent('live0000001').viewCountAtEnd, 520);

  videos.set('live0000001', makeVideo({ liveBroadcastContent: 'none', actualEndTime: '2026-10-18T11:00:00Z', concurrentViewers: null, viewCount: 610 }));
  app.setTime('2026-10-25T11:00:01Z');
  await app.tracker.tick();

  assert.equal(app.sent.length, 1);
  assert.match(app.sent[0].text, /Tallenteen katselut \(7 vrk päättymisestä\): 90/);
});

test('forms are deleted a week after the report was sent, the reported figures stay', async () => {
  const videos = new Map([['live0000001', makeVideo()]]);
  const app = await setup({ videos });
  await app.tracker.tick();
  videos.set('live0000001', makeVideo({ liveBroadcastContent: 'none', actualEndTime: '2026-10-18T11:00:00Z', concurrentViewers: null }));
  app.setTime('2026-10-18T11:05:00Z');
  await app.tracker.tick();
  const event = app.store.getEvent('live0000001');
  event.submissions.push({ id: 's1', groupName: 'Ryhmä', watchers: 5, contactEmail: null, createdAt: '2026-10-18T11:10:00Z' });

  await app.tracker.sendReport(event, new Date('2026-10-21T21:00:00Z'));
  assert.equal(event.reportSnapshot.groups, 1);

  app.setTime('2026-10-28T20:59:00Z');
  await app.tracker.tick();
  assert.equal(event.submissions.length, 1);

  app.setTime('2026-10-28T21:00:01Z');
  await app.tracker.tick();
  assert.equal(event.submissions.length, 0);
  assert.ok(event.formsPurgedAt);
  assert.equal(event.reportSnapshot.watchers, 5);
});

test('a sent report can be sent again, also after the forms were deleted, with the reported figures', async () => {
  const videos = new Map([['live0000001', makeVideo()]]);
  const app = await setup({ videos });
  await app.tracker.tick();
  videos.set('live0000001', makeVideo({ liveBroadcastContent: 'none', actualEndTime: '2026-10-18T11:00:00Z', concurrentViewers: null }));
  app.setTime('2026-10-18T11:05:00Z');
  await app.tracker.tick();
  const event = app.store.getEvent('live0000001');
  event.submissions.push({ id: 's1', groupName: 'Ryhmä', watchers: 5, contactEmail: 'a@example.com', createdAt: '2026-10-18T11:10:00Z' });

  await assert.rejects(app.tracker.sendReport(event, new Date(), { resend: true }), /ei ole vielä lähetetty/);
  await app.tracker.sendReport(event, new Date('2026-10-21T21:00:00Z'));
  await assert.rejects(app.tracker.sendReport(event), /jo lähetetty/);

  await app.tracker.sendReport(event, new Date('2026-10-22T08:00:00Z'), { resend: true });
  assert.equal(app.sent.length, 2);
  assert.equal(event.reportSentAt, '2026-10-21T21:00:00.000Z');
  assert.equal(event.reportResentAt, '2026-10-22T08:00:00.000Z');
  assert.match(app.sent[1].text, /- Ryhmä: 5/);

  app.setTime('2026-10-28T21:00:01Z');
  await app.tracker.tick();
  assert.equal(event.submissions.length, 0);
  await app.tracker.sendReport(event, new Date('2026-10-29T08:00:00Z'), { resend: true });
  assert.match(app.sent[2].text, /Lomakkeet on poistettu/);
  assert.match(app.sent[2].text, /Lomakeryhmiä: 1, ryhmien katsojia yhteensä: 5/);
});

test('YouTube is asked at most once per interval, and once more just before the report', async () => {
  const videos = new Map([['live0000001', makeVideo({ viewCount: 100 })]]);
  const calls = { uploads: 0, videos: 0 };
  const youtube = {
    async getChannelUploads() {
      calls.uploads += 1;
      return [...videos.values()];
    },
    async getVideos(ids) {
      calls.videos += 1;
      return ids.map((id) => videos.get(id)).filter(Boolean);
    },
  };
  let clock = new Date('2026-10-18T11:05:00Z');
  const sent = [];
  const store = await createStore({ defaults: { ...DEFAULT_SETTINGS, reportRecipient: 'a@example.com', senderEmail: 'b@example.com' } });
  const tracker = createTracker({
    config: { youtubeChannelIds: [CHANNEL], publicBaseUrl: 'https://x.fi', pollIntervalSeconds: 3600 },
    store,
    youtube,
    mailer: { async send(m) { sent.push(m); } },
    now: () => clock,
    log: { error() {} },
  });
  await tracker.tick();
  videos.set('live0000001', makeVideo({ liveBroadcastContent: 'none', actualEndTime: '2026-10-18T11:00:00Z', concurrentViewers: null, viewCount: 100 }));
  const afterFirst = { ...calls };
  for (const minute of ['11:06', '11:30', '12:04']) {
    clock = new Date(`2026-10-18T${minute}:00Z`);
    await tracker.tick();
  }
  assert.deepEqual(calls, afterFirst);

  clock = new Date('2026-10-18T12:06:00Z');
  await tracker.tick();
  assert.equal(calls.uploads, afterFirst.uploads + 1);

  // The report due time brings one extra view-count read for this video.
  const before = calls.videos;
  videos.set('live0000001', { ...videos.get('live0000001'), viewCount: 180 });
  clock = new Date('2026-10-24T21:00:01Z');
  await tracker.tick();
  assert.equal(sent.length, 1);
  assert.ok(calls.videos > before);
  assert.equal(store.getEvent('live0000001').youtube.viewCount, 180);
});
