export const EVENT_TYPES = {
  worship: { label: 'Jumalanpalvelus', reportAfterHours: 48 },
  ceremony: { label: 'Kirkollinen toimitus', reportAfterHours: 0 },
  other: { label: 'Muu tilaisuus', reportAfterHours: 24 },
};

export const COUNTING_SCHEMES = {
  max_concurrent: 'Samanaikaisten katsojien enimmäismäärä',
  average_concurrent: 'Samanaikaisten katsojien keskiarvo',
  views: 'Katselukerrat yhteensä',
};

export const CLOSE_GRACE_MINUTES = 30;

export const TEMPLATE_KEYS = ['EVENT NAME', 'EVENT URL', 'SUMMARY', 'FILLED FORMS', 'YOUTUBE COUNTS'];

export const DEFAULT_SETTINGS = {
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
const HOUR_MS = 3_600_000;
const TIME_ZONE = 'Europe/Helsinki';

export function createEvent(fields) {
  return {
    source: 'manual',
    title: '',
    eventType: 'other',
    countingScheme: 'max_concurrent',
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

// Guidelines: worship services are counted two days after they end,
// ceremonies only while they are being watched, other events after a day.
export function reportAt(event) {
  if (!event.endsAt) return null;
  return new Date(Date.parse(event.endsAt) + EVENT_TYPES[event.eventType].reportAfterHours * HOUR_MS);
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
export function countParticipants(event) {
  switch (event.countingScheme) {
    case 'max_concurrent':
      return event.analytics?.peakConcurrentViewers ?? maxViewers(event);
    case 'average_concurrent':
      return event.analytics?.averageConcurrentViewers ?? averageViewers(event);
    case 'views':
      return event.youtube?.viewCount ?? null;
    default:
      throw new Error(`Unknown counting scheme: ${event.countingScheme}`);
  }
}

export function renderTemplate(template, values) {
  return template.replace(
    /\[(EVENT NAME|EVENT URL|SUMMARY|FILLED FORMS|YOUTUBE COUNTS)\]/g,
    (tag, key) => values[key] ?? tag,
  );
}

export function youtubeCountLines(event) {
  if (event.source !== 'youtube') return 'Ei YouTube-tietoja (manuaalinen linkki).';
  const lines = [
    ['Samanaikaisia katsojia (enimmäismäärä)', event.analytics?.peakConcurrentViewers ?? maxViewers(event)],
    ['Samanaikaisia katsojia (keskiarvo)', event.analytics?.averageConcurrentViewers ?? averageViewers(event)],
    ['Katselukerrat yhteensä', event.youtube?.viewCount ?? null],
  ];
  return lines.map(([label, value]) => `${label}: ${value ?? 'ei saatavilla'}`).join('\n');
}

export function buildReport(event, settings, publicBaseUrl) {
  const participants = countParticipants(event);
  const watchers = event.submissions.reduce((sum, submission) => sum + submission.watchers, 0);
  const values = {
    'EVENT NAME': event.title,
    'EVENT URL': `${publicBaseUrl}/e/${event.id}`,
    SUMMARY: [
      `Tyyppi: ${EVENT_TYPES[event.eventType].label}`,
      `Päättyi: ${event.endsAt ? formatDateTime(event.endsAt) : 'ei tiedossa'}`,
      `Lomakkeita: ${event.submissions.length}, katsojia lomakkeilla yhteensä: ${watchers}`,
      participants === null
        ? 'Verkon kautta osallistuneita ei voitu arvioida.'
        : `Verkon kautta osallistuneet (${COUNTING_SCHEMES[event.countingScheme]}): ${participants}`,
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
