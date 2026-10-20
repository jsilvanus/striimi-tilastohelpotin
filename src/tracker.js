import { buildReport, createEvent, estimateParticipants, formsPurgeAt, reportAt } from './domain.js';

const MISSING_VIDEO_TTL_MS = 10 * 60_000;

// youtube, analytics and mailer may be clients or functions returning one (or null), so that
// credentials saved in the admin view apply without a restart.
const current = (client) => (typeof client === 'function' ? client() : client);

export function createTracker({ config, store, youtube: youtubeClient = null, analytics: analyticsClient = null, mailer: mailerClient = null, now = () => new Date(), log = console }) {
  const missingVideos = new Map();
  let running = false;
  let lastYoutubeAt = null;
  let timer = null;

  function youtubeState(video, ts) {
    return {
      liveBroadcastContent: video.liveBroadcastContent,
      viewCount: video.viewCount,
      checkedAt: ts.toISOString(),
    };
  }

  function eventFromVideo(video, ts) {
    return createEvent({
      id: video.id,
      source: 'youtube',
      title: video.title,
      channelId: video.channelId,
      startsAt: video.actualStartTime ?? video.scheduledStartTime ?? video.publishedAt,
      endsAt: video.actualEndTime,
      createdAt: ts.toISOString(),
      youtube: youtubeState(video, ts),
    });
  }

  function applyVideo(event, video, ts) {
    event.youtube = youtubeState(video, ts);
    if (video.actualEndTime && !event.endsAt) event.endsAt = video.actualEndTime;
    // The recording's views are counted from the end of the stream, so keep the count at that point.
    if (event.endsAt && event.viewCountAtEnd == null && video.viewCount != null && Date.parse(event.endsAt) <= ts) {
      event.viewCountAtEnd = video.viewCount;
    }
  }

  // Finds new live and upcoming streams on the configured channels.
  async function discover(ts, youtube) {
    for (const channelId of config.youtubeChannelIds) {
      for (const video of await youtube.getChannelUploads(channelId)) {
        if (video.liveBroadcastContent === 'none' || store.getEvent(video.id)) continue;
        await store.putEvent(eventFromVideo(video, ts));
      }
    }
  }

  // Reads the state and view count of followed videos (detects when streams end). Live viewers are not sampled.
  async function refresh(ts, youtube) {
    const ids = store
      .listEvents()
      .filter((event) => event.source === 'youtube' && event.enabled && !event.reportSentAt)
      .map((event) => event.id);
    if (!ids.length) return;
    for (const video of await youtube.getVideos(ids)) {
      applyVideo(store.getEvent(video.id), video, ts);
    }
    await store.save();
  }

  // Analytics data lags the stream slightly, so it is fetched when the report is due.
  // If it is unavailable, the live figures are reported as not available and a resend can fetch them later.
  async function fetchAnalytics(event, ts) {
    const analytics = current(analyticsClient);
    if (!analytics || event.source !== 'youtube' || event.analytics) return;
    const startDate = (event.startsAt ?? event.createdAt).slice(0, 10);
    try {
      const totals = await analytics.getLivestreamTotals({
        channelId: event.channelId,
        videoId: event.id,
        startDate,
        endDate: ts.toISOString().slice(0, 10),
      });
      if (totals) event.analytics = { ...totals, fetchedAt: ts.toISOString() };
    } catch (err) {
      log.error(`YouTube Analytics -haku epäonnistui (${event.id}), live-lukuja ei saatu: ${err.message}`);
    }
  }

  // The view count is read once more just before a report so that it is as fresh as possible.
  async function refreshViews(event, ts) {
    const youtube = current(youtubeClient);
    if (!youtube || event.source !== 'youtube') return;
    try {
      const [video] = await youtube.getVideos([event.id]);
      if (video) applyVideo(event, video, ts);
    } catch (err) {
      log.error(`Katselukertojen haku ennen raporttia epäonnistui (${event.id}): ${err.message}`);
    }
  }

  async function sendReport(event, ts = now(), { resend = false } = {}) {
    if (event.reportSentAt && !resend) throw new Error('Raportti on jo lähetetty.');
    if (resend && !event.reportSentAt) throw new Error('Raporttia ei ole vielä lähetetty.');
    const mailer = current(mailerClient);
    if (!mailer) throw new Error('Sähköpostia ei voi lähettää: BREVO_API_KEY puuttuu.');
    const settings = store.getSettings();
    if (!settings.reportRecipient || !settings.senderEmail) {
      throw new Error('Asetuksista puuttuu raportin vastaanottaja tai lähettäjän sähköposti.');
    }
    if (!resend) await refreshViews(event, ts);
    // A resend tries Analytics again if the first attempt got nothing.
    await fetchAnalytics(event, ts);
    const { subject, text } = buildReport(event, settings, config.publicBaseUrl);
    await mailer.send({
      sender: { name: settings.senderName || settings.senderEmail, email: settings.senderEmail },
      to: settings.reportRecipient,
      subject,
      text,
    });
    if (resend) {
      // The retention period keeps running from the first send.
      event.reportResentAt = ts.toISOString();
      if (!event.formsPurgedAt) event.reportSnapshot = estimateParticipants(event, settings);
    } else {
      event.reportSentAt = ts.toISOString();
      // The forms (and contact emails) are deleted after a week, so keep the figures that were reported.
      event.reportSnapshot = estimateParticipants(event, settings);
    }
    await store.save();
  }

  async function sendDueReports(ts) {
    for (const event of store.listEvents()) {
      if (!event.enabled || event.reportSentAt) continue;
      const due = reportAt(event);
      if (!due || ts < due) continue;
      try {
        await sendReport(event, ts);
      } catch (err) {
        log.error(`Raportin lähetys epäonnistui (${event.id}): ${err.message}`);
      }
    }
  }

  // Deletes the submitted forms a week after the report was sent. The reported figures stay in the snapshot.
  async function purgeForms(ts) {
    let changed = false;
    for (const event of store.listEvents()) {
      const due = formsPurgeAt(event);
      if (!due || ts < due || event.formsPurgedAt) continue;
      event.submissions = [];
      event.formsPurgedAt = ts.toISOString();
      changed = true;
    }
    if (changed) await store.save();
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const ts = now();
      const youtube = current(youtubeClient);
      // YouTube is asked at most once per interval (an hour in production), not on every local tick.
      const youtubeDue = lastYoutubeAt === null || ts.getTime() - lastYoutubeAt >= (config.pollIntervalSeconds ?? 0) * 1000;
      if (youtube && youtubeDue) {
        lastYoutubeAt = ts.getTime();
        try {
          await discover(ts, youtube);
          await refresh(ts, youtube);
        } catch (err) {
          log.error(`YouTube-päivitys epäonnistui: ${err.message}`);
        }
      }
      await sendDueReports(ts);
      await purgeForms(ts);
    } finally {
      running = false;
    }
  }

  // Returns the stored event for a YouTube video, creating it if the video is on a configured channel.
  async function resolveVideo(videoId) {
    const existing = store.getEvent(videoId);
    if (existing) return existing;
    const youtube = current(youtubeClient);
    if (!youtube) return null;

    const missingAt = missingVideos.get(videoId);
    if (missingAt !== undefined && now().getTime() - missingAt < MISSING_VIDEO_TTL_MS) return null;

    const [video] = await youtube.getVideos([videoId]);
    if (!video || !config.youtubeChannelIds.includes(video.channelId)) {
      missingVideos.set(videoId, now().getTime());
      return null;
    }
    return store.putEvent(eventFromVideo(video, now()));
  }

  function start(intervalMs) {
    const run = () => tick().catch((err) => log.error(`Seurantakierros epäonnistui: ${err.message}`));
    run();
    timer = setInterval(run, intervalMs);
  }

  function stop() {
    clearInterval(timer);
  }

  return { tick, start, stop, resolveVideo, sendReport };
}
