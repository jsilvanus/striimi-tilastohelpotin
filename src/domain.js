// vodDays: how long after the end the recording is counted (the stats recording boundary).
export const EVENT_TYPES = {
  worship: { label: 'Jumalanpalvelus', vodDays: 3 },
  ceremony: { label: 'Kirkollinen toimitus', vodDays: 0 },
  other: { label: 'Muu tilaisuus', vodDays: 7 },
};

export const MAX_VOD_DAYS = 21;

// Live models; the global default is set in settings and can be overridden per event.
export const COUNTING_SCHEMES = {
  max_concurrent: 'Samanaikaisten katsojien enimmäismäärä',
  average_concurrent: 'Samanaikaisten katsojien keskiarvo',
};

export const CLOSE_GRACE_MINUTES = 30;

export const TEMPLATE_KEYS = ['EVENT NAME', 'EVENT URL', 'SUMMARY', 'FILLED FORMS', 'YOUTUBE COUNTS'];

export const DEFAULT_SETTINGS = {
  liveModel: 'average_concurrent',
  parishName: '',
  parishLogoUrl: '',
  reportRecipient: '',
  senderName: 'Striimitilastot',
  senderEmail: '',
  emailSubject: 'Tilastoi striimin osallistujat: [EVENT NAME]',
  emailBody: [
    'Hei,',
    '',
    'tilaisuus "[EVENT NAME]" on päättynyt. Ole hyvä ja kirjaa sen osallistujatilasto.',
    'Tilaisuuden linkki: [EVENT URL]',
    '',
    '[SUMMARY]',
    '',
    'Verkkolomakkeella ilmoitetut:',
    '[FILLED FORMS]',
    '',
    'YouTube-luvut:',
    '[YOUTUBE COUNTS]',
    '',
    'Kiitos!',
  ].join('\n'),
};

const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const MINUTE_MS = 60_000;
const TIME_ZONE = 'Europe/Helsinki';

export function createEvent(fields) {
  return {
    source: 'manual',
    title: '',
    eventType: 'other',
    countingScheme: null,
    vodDays: null,
    viewCountAtEnd: null,
    url: null,
    channelId: null,
    startsAt: null,
    endsAt: null,
    closedAt: null,
    analytics: null,
    enabled: true,
    samples: [],
    youtube: null,
    submissions: [],
    reportSentAt: null,
    ...fields,
  };
}

// The form stays open until the event has ended (endsAt) plus a grace period.
// While endsAt is unknown (live or upcoming stream) the form is open.
export function closesAt(event) {
  return event.endsAt ? new Date(Date.parse(event.endsAt) + CLOSE_GRACE_MINUTES * MINUTE_MS) : null;
}

export function isFormOpen(event, now) {
  if (!event.enabled) return false;
  if (event.closedAt && now >= Date.parse(event.closedAt)) return false;
  const closing = closesAt(event);
  return !closing || now < closing;
}

export function vodDaysOf(event) {
  return event.vodDays ?? EVENT_TYPES[event.eventType].vodDays;
}

export function liveModelOf(event, settings) {
  return event.countingScheme ?? settings.liveModel;
}

function addCalendarDays(ymd, days) {
  const date = new Date(`${ymd}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// The storage window is whole calendar days in Finnish time: a service on day D is
// stored through day D + (vodDays - 1), and the report is due at midnight that ends it.
// Zero days means the report is due as soon as the event ends.
export function reportAt(event) {
  if (!event.endsAt) return null;
  const days = vodDaysOf(event);
  if (days === 0) return new Date(event.endsAt);
  const lastDay = toLocalInput(event.endsAt).slice(0, 10);
  return new Date(fromLocalInput(`${addCalendarDays(lastDay, days)}T00:00`));
}

export function eventStatus(event, now) {
  if (event.reportSentAt) return 'Raportoitu';
  if (!event.enabled) return 'Ei seurannassa';
  if (!event.endsAt) return 'Käynnissä tai tulossa';
  if (isFormOpen(event, now)) return 'Lomake auki';
  return 'Suljettu, raportti odottaa';
}

export function maxViewers(event) {
  const values = event.samples.map((sample) => sample.viewers);
  return values.length ? Math.max(...values) : null;
}

// Samples are taken at a fixed interval, so their mean approximates
// combined watch time divided by the length of the stream.
export function averageViewers(event) {
  const values = event.samples.map((sample) => sample.viewers);
  if (!values.length) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

// YouTube Analytics values (fetched at report time) are preferred over our own samples.
export function liveValue(event, model) {
  if (model === 'max_concurrent') return event.analytics?.peakConcurrentViewers ?? maxViewers(event);
  return event.analytics?.averageConcurrentViewers ?? averageViewers(event);
}

// Views accrued on the recording between the end of the stream and the storage boundary.
export function vodViews(event) {
  if (vodDaysOf(event) === 0) return 0;
  if (event.viewCountAtEnd == null || event.youtube?.viewCount == null) return null;
  return Math.max(0, event.youtube.viewCount - event.viewCountAtEnd);
}

// Total = live viewers (each registered group replaces one live viewer) + group watchers + recording views.
export function estimateParticipants(event, settings) {
  const model = liveModelOf(event, settings);
  const live = liveValue(event, model);
  const groups = event.submissions.length;
  const watchers = event.submissions.reduce((sum, submission) => sum + submission.watchers, 0);
  const liveAfterGroups = live === null ? null : Math.max(0, live - groups);
  const vod = vodViews(event);
  const unknown = liveAfterGroups === null && vod === null && groups === 0;
  const total = unknown ? null : (liveAfterGroups ?? 0) + watchers + (vod ?? 0);
  return { model, live, groups, watchers, liveAfterGroups, vod, total };
}

export function renderTemplate(template, values) {
  return template.replace(
    /\[(EVENT NAME|EVENT URL|SUMMARY|FILLED FORMS|YOUTUBE COUNTS)\]/g,
    (tag, key) => values[key] ?? tag,
  );
}

const orUnavailable = (value) => value ?? 'ei saatavilla';

export function youtubeCountLines(event) {
  if (event.source !== 'youtube') return 'Ei YouTube-tietoja (manuaalinen linkki).';
  const lines = [
    ['Samanaikaisia katsojia (enimmäismäärä)', liveValue(event, 'max_concurrent')],
    ['Samanaikaisia katsojia (keskiarvo)', liveValue(event, 'average_concurrent')],
    ['Katselukerrat yhteensä', event.youtube?.viewCount ?? null],
    [`Tallenteen katselut (${vodDaysOf(event)} vrk päättymisestä)`, vodViews(event)],
  ];
  return lines.map(([label, value]) => `${label}: ${orUnavailable(value)}`).join('\n');
}

export function buildReport(event, settings, publicBaseUrl) {
  const est = estimateParticipants(event, settings);
  const values = {
    'EVENT NAME': event.title,
    'EVENT URL': `${publicBaseUrl}/e/${event.id}`,
    SUMMARY: [
      `Tyyppi: ${EVENT_TYPES[event.eventType].label}`,
      `Päättyi: ${event.endsAt ? formatDateTime(event.endsAt) : 'ei tiedossa'}`,
      `Live-katsojat (${COUNTING_SCHEMES[est.model]}): ${orUnavailable(est.live)}`,
      `Lomakeryhmiä: ${est.groups}, ryhmien katsojia yhteensä: ${est.watchers}`,
      `Live-luku ryhmien jälkeen (ryhmä vähentää yhden live-katsojan): ${orUnavailable(est.liveAfterGroups)}`,
      `Tallenteen katselut (${vodDaysOf(event)} vrk päättymisestä): ${orUnavailable(est.vod)}`,
      est.total === null ? 'Osallistujia ei voitu arvioida.' : `Osallistujat yhteensä: ${est.total}`,
    ].join('\n'),
    'FILLED FORMS': event.submissions.length
      ? event.submissions.map((submission) => `- ${submission.groupName}: ${submission.watchers}`).join('\n')
      : 'Ei lomakkeita.',
    'YOUTUBE COUNTS': youtubeCountLines(event),
  };
  return {
    subject: renderTemplate(settings.emailSubject, values),
    text: renderTemplate(settings.emailBody, values),
  };
}

const dateTimeFormat = new Intl.DateTimeFormat('fi-FI', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: TIME_ZONE,
});

const wallClockFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export function formatDateTime(iso) {
  return dateTimeFormat.format(new Date(iso));
}

function wallClockParts(date) {
  return Object.fromEntries(wallClockFormat.formatToParts(date).map((part) => [part.type, part.value]));
}

// Converts a <input type="datetime-local"> value (Helsinki wall-clock time) to ISO.
export function fromLocalInput(value) {
  if (!LOCAL_DATE_TIME.test(value ?? '')) return null;
  const wallAsUtc = Date.parse(`${value}:00Z`);
  if (Number.isNaN(wallAsUtc)) return null;
  const instant = new Date(wallAsUtc);
  const parts = wallClockParts(instant);
  const shownAsUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offset = shownAsUtc - instant.getTime();
  return new Date(wallAsUtc - offset).toISOString();
}

export function toLocalInput(iso) {
  if (!iso) return '';
  const parts = wallClockParts(new Date(iso));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
