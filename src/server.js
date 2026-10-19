import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { COUNTING_SCHEMES, EVENT_TYPES, MAX_VOD_DAYS, createEvent, fromLocalInput, isFormOpen } from './domain.js';
import * as views from './views.js';

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_BODY_BYTES = 16 * 1024;
const CSP = [
  "default-src 'self'",
  'img-src https:',
  'frame-src https://www.youtube-nocookie.com',
  "style-src 'unsafe-inline'",
  "form-action 'self'",
].join('; ');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, contentType = 'text/html; charset=utf-8', headers = {}) {
  res.writeHead(status, {
    'content-type': contentType,
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...headers,
  });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(303, { location });
  res.end();
}

function back(res, message) {
  redirect(res, `/admin?msg=${encodeURIComponent(message)}`);
}

async function readForm(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Lomake on liian suuri.');
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

const text = (form, name) => String(form.get(name) ?? '').trim();

function isHttpUrl(value) {
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function optionalDate(value) {
  const input = String(value ?? '').trim();
  if (!input) return null;
  const iso = fromLocalInput(input);
  if (!iso) throw new HttpError(400, 'Virheellinen päivämäärä.');
  return iso;
}

function enumValue(value, allowed, label) {
  if (!Object.hasOwn(allowed, value)) throw new HttpError(400, `Virheellinen ${label}.`);
  return value;
}

// An empty select means "use the default" and is stored as null.
function optionalEnum(value, allowed, label) {
  return String(value ?? '') === '' ? null : enumValue(value, allowed, label);
}

function parseVodDays(value) {
  const input = String(value ?? '').trim();
  if (input === '') return null;
  const days = Number(input);
  if (!Number.isInteger(days) || days < 0 || days > MAX_VOD_DAYS) {
    throw new HttpError(400, `Tallennusaika on oltava 0–${MAX_VOD_DAYS} vrk.`);
  }
  return days;
}

function parseSubmission(form) {
  const values = {
    groupName: text(form, 'groupName'),
    watchers: text(form, 'watchers'),
    contactEmail: text(form, 'contactEmail'),
  };
  const watchers = Number(values.watchers);
  const errors = [];
  if (!values.groupName || values.groupName.length > 100) {
    errors.push('Anna ryhmän nimi tai nimimerkki (enintään 100 merkkiä).');
  }
  if (!Number.isInteger(watchers) || watchers < 1 || watchers > 10000) {
    errors.push('Katsojamäärän pitää olla kokonaisluku väliltä 1–10 000.');
  }
  if (values.contactEmail && (values.contactEmail.length > 200 || !EMAIL.test(values.contactEmail))) {
    errors.push('Yhteystiedon sähköpostiosoite ei ole kelvollinen.');
  }
  return {
    values,
    errors,
    data: {
      groupName: values.groupName,
      watchers,
      contactEmail: values.contactEmail || null,
    },
  };
}

function validateSettings(settings) {
  const problems = [];
  if (!settings.emailSubject) problems.push('Sähköpostin aihe puuttuu.');
  if (!settings.emailBody) problems.push('Sähköpostin runko puuttuu.');
  if (settings.parishLogoUrl && !isHttpUrl(settings.parishLogoUrl)) problems.push('Logon osoite ei ole kelvollinen.');
  if (settings.reportRecipient && !EMAIL.test(settings.reportRecipient)) problems.push('Raportin vastaanottajan sähköposti ei ole kelvollinen.');
  if (settings.senderEmail && !EMAIL.test(settings.senderEmail)) problems.push('Lähettäjän sähköposti ei ole kelvollinen.');
  return problems;
}

function digest(value) {
  return createHash('sha256').update(value).digest();
}

function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let host = null;
  try {
    host = new URL(origin).host;
  } catch {
    host = null;
  }
  if (host !== req.headers.host) throw new HttpError(403, 'Pyyntö estettiin.');
}

export function createApp({ config, store, tracker, youtube = null }) {
  function isAuthorized(req) {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Basic ')) return false;
    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
    const password = decoded.slice(decoded.indexOf(':') + 1);
    return timingSafeEqual(digest(password), digest(config.adminPassword));
  }

  async function findEvent(id) {
    const stored = store.getEvent(id);
    if (stored) return stored;
    const event = YOUTUBE_ID.test(id) ? await tracker.resolveVideo(id) : null;
    if (!event) throw new HttpError(404, 'Tilaisuutta ei löydy. Tarkista linkki.');
    return event;
  }

  async function showPublicPage(res, id, url) {
    const event = await findEvent(id);
    const open = isFormOpen(event, new Date());
    send(
      res,
      open ? 200 : 410,
      views.publicPage({
        event,
        settings: store.getSettings(),
        open,
        saved: url.searchParams.get('saved') === '1',
      }),
    );
  }

  async function submitForm(req, res, id) {
    const event = await findEvent(id);
    if (!isFormOpen(event, new Date())) throw new HttpError(410, 'Tilaston tallennus on päättynyt.');
    const form = await readForm(req);
    const { values, errors, data } = parseSubmission(form);
    if (errors.length) {
      send(res, 422, views.publicPage({ event, settings: store.getSettings(), open: true, errors, values }));
      return;
    }
    event.submissions.push({ id: randomUUID(), createdAt: new Date().toISOString(), ...data });
    await store.save();
    redirect(res, `/e/${encodeURIComponent(id)}?saved=1`);
  }

  async function listChannelVideos() {
    if (!youtube) return { videos: [], error: 'YouTube-avain puuttuu (YOUTUBE_API_KEY).' };
    try {
      const lists = await Promise.all(config.youtubeChannelIds.map((id) => youtube.getChannelUploads(id)));
      return { videos: lists.flat(), error: null };
    } catch (err) {
      return { videos: [], error: `Videoita ei saatu YouTubesta: ${err.message}` };
    }
  }

  async function showAdmin(res, url) {
    const { videos, error } = await listChannelVideos();
    send(
      res,
      200,
      views.adminPage({
        events: store.listEvents(),
        settings: store.getSettings(),
        videos,
        videosError: error,
        flash: url.searchParams.get('msg') ?? '',
        now: new Date(),
      }),
    );
  }

  async function saveSettings(res, form) {
    const settings = {
      parishName: text(form, 'parishName'),
      parishLogoUrl: text(form, 'parishLogoUrl'),
      liveModel: enumValue(form.get('liveModel'), COUNTING_SCHEMES, 'laskentatapa'),
      reportRecipient: text(form, 'reportRecipient'),
      senderName: text(form, 'senderName'),
      senderEmail: text(form, 'senderEmail'),
      emailSubject: text(form, 'emailSubject'),
      emailBody: text(form, 'emailBody'),
    };
    const problems = validateSettings(settings);
    if (problems.length) throw new HttpError(400, problems.join(' '));
    await store.updateSettings(settings);
    back(res, 'Asetukset tallennettu.');
  }

  async function createManualEvent(res, form) {
    const title = text(form, 'title');
    const url = text(form, 'url');
    const endsAt = optionalDate(form.get('endsAt'));
    if (!title || !isHttpUrl(url)) throw new HttpError(400, 'Nimi ja http(s)-osoite vaaditaan.');
    if (!endsAt) throw new HttpError(400, 'Päättymisaika vaaditaan, jotta raportti voidaan lähettää.');
    const event = createEvent({
      id: randomBytes(9).toString('base64url'),
      source: 'manual',
      title,
      url,
      eventType: enumValue(form.get('eventType'), EVENT_TYPES, 'tyyppi'),
      endsAt,
      createdAt: new Date().toISOString(),
    });
    await store.putEvent(event);
    back(res, 'Linkki luotu.');
  }

  async function followVideo(res, form) {
    const videoId = text(form, 'videoId');
    if (!YOUTUBE_ID.test(videoId)) throw new HttpError(400, 'Virheellinen videotunnus.');
    try {
      const event = await tracker.resolveVideo(videoId);
      back(res, event ? 'Video on seurannassa.' : 'Videoa ei löytynyt seurattavilta kanavilta.');
    } catch (err) {
      back(res, `Videon lisääminen epäonnistui: ${err.message}`);
    }
  }

  async function updateEvent(res, id, form) {
    const event = store.getEvent(id);
    if (!event) throw new HttpError(404, 'Tilaisuutta ei löydy.');
    const action = form.get('action');

    if (action === 'close') {
      const nowIso = new Date().toISOString();
      event.closedAt = nowIso;
      event.endsAt = nowIso;
      await store.save();
      back(res, 'Linkki suljettu.');
      return;
    }
    if (action === 'report') {
      try {
        await tracker.sendReport(event);
        back(res, 'Raportti lähetetty.');
      } catch (err) {
        back(res, err.message);
      }
      return;
    }
    if (action !== 'save') throw new HttpError(400, 'Tuntematon toiminto.');

    const title = text(form, 'title');
    if (!title) throw new HttpError(400, 'Nimi puuttuu.');
    Object.assign(event, {
      title,
      eventType: enumValue(form.get('eventType'), EVENT_TYPES, 'tyyppi'),
      countingScheme: optionalEnum(form.get('countingScheme'), COUNTING_SCHEMES, 'laskentatapa'),
      vodDays: parseVodDays(form.get('vodDays')),
      endsAt: optionalDate(form.get('endsAt')),
      closedAt: null,
      enabled: form.has('enabled'),
    });
    await store.save();
    back(res, 'Tallennettu.');
  }

  async function admin(req, res, url) {
    if (!config.adminPassword) throw new HttpError(503, 'Ylläpito ei ole käytössä: ADMIN_PASSWORD puuttuu.');
    if (!isAuthorized(req)) {
      send(res, 401, views.errorPage('Kirjaudu ylläpitäjänä.'), undefined, {
        'www-authenticate': 'Basic realm="Tilastot", charset="UTF-8"',
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/admin') return showAdmin(res, url);
    if (req.method !== 'POST') throw new HttpError(405, 'Virheellinen pyyntö.');

    assertSameOrigin(req);
    const form = await readForm(req);
    if (url.pathname === '/admin/settings') return saveSettings(res, form);
    if (url.pathname === '/admin/events/manual') return createManualEvent(res, form);
    if (url.pathname === '/admin/events/from-video') return followVideo(res, form);

    const match = url.pathname.match(/^\/admin\/events\/([^/]+)$/);
    if (match) return updateEvent(res, decodeURIComponent(match[1]), form);
    throw new HttpError(404, 'Sivua ei löydy.');
  }

  async function route(req, res, url) {
    const { pathname } = url;
    if (pathname === '/health') {
      send(res, 200, 'ok', 'text/plain; charset=utf-8');
      return;
    }
    const publicMatch = pathname.match(/^\/e\/([^/]+)$/);
    if (publicMatch) {
      const id = decodeURIComponent(publicMatch[1]);
      if (req.method === 'GET') return showPublicPage(res, id, url);
      if (req.method === 'POST') return submitForm(req, res, id);
      throw new HttpError(405, 'Virheellinen pyyntö.');
    }
    if (pathname === '/admin' || pathname.startsWith('/admin/')) return admin(req, res, url);
    throw new HttpError(404, 'Sivua ei löydy.');
  }

  return async function handle(req, res) {
    try {
      await route(req, res, new URL(req.url, 'http://localhost'));
    } catch (err) {
      if (err instanceof HttpError) {
        send(res, err.status, views.errorPage(err.message));
        return;
      }
      console.error(err);
      send(res, 500, views.errorPage('Palvelussa tapahtui virhe.'));
    }
  };
}
