import { buildReport, createEvent, estimateParticipants, formsPurgeAt, reportAt } from './domain.js';

const MISSING_VIDEO_TTL_MS = 10 * 60_000;

// youtube, analytics and mailer may be clients or functions returning one (or null), so that
// credentials saved in the admin view apply without a restart.
const current = (client) => (typeof client === 'function' ? client() : client);

export function createTracker({ config, store, youtube: youtubeClient = null, analytics: analyticsClient = null, mailer: mailerClient = null, now = () => new Date(), log = console }) {
  const missingVideos = new Map();
  let running = false;
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
    if (video.liveBroadcastContent === 'live' && video.concurrentViewers !== null) {
      event.samples.push({ at: ts.toISOString(), viewers: video.concurrentViewers });
    }
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

  // Samples concurrent viewers and detects when streams end.
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
  // If it is unavailable, the report falls back to the values sampled during the stream.
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
      log.error(`YouTube Analytics -haku epäonnistui (${event.id}), käytetään näytteitä: ${err.message}`);
    }
  }

  async function sendReport(event, ts = now()) {
    if (event.reportSentAt) throw new Error('Raportti on jo lähetetty.');
    const mailer = current(mailerClient);
    if (!mailer) throw new Error('Sähköpostia ei voi lähettää: BREVO_API_KEY puuttuu.');
    const settings = store.getSettings();
    if (!settings.reportRecipient || !settings.senderEmail) {
      throw new Error('Asetuksista puuttuu raportin vastaanottaja tai lähettäjän sähköposti.');
    }
    await fetchAnalytics(event, ts);
    const { subject, text } = buildReport(event, settings, config.publicBaseUrl);
    await mailer.send({
      sender: { name: settings.senderName || settings.senderEmail, email: settings.senderEmail },
      to: settings.reportRecipient,
      subject,
      text,
    });
    event.reportSentAt = ts.toISOString();
    // The forms are deleted after a week, so keep the figures that were reported.
    event.reportSnapshot = estimateParticipants(event, settings);
    // Contact details are only needed to reach the group; drop them once the report has gone out.
    for (const submission of event.submissions) submission.contactEmail = null;
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
      if (youtube) {
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
