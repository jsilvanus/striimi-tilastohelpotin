import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { buildConsentUrl, exchangeCode, fetchIdentity } from './oauth.js';
import { COUNTING_SCHEMES, EVENT_TYPES, buildReport, MAX_VOD_DAYS, createEvent, fromLocalInput, isFormOpen } from './domain.js';
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

function backTo(res, message, next = '/admin') {
  // Only paths inside the admin view are accepted as a return target.
  const target = /^\/admin(\/[A-Za-z0-9_\-%]*)*$/.test(next) ? next : '/admin';
  redirect(res, `${target}?msg=${encodeURIComponent(message)}`);
}

const back = (res, message) => backTo(res, message);

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

export function createApp({ config, store, tracker, youtube: youtubeClient = null, credentials = null, secrets = null, fetchImpl = fetch }) {
  const currentYouTube = () => (typeof youtubeClient === 'function' ? youtubeClient() : youtubeClient);
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
    const youtube = currentYouTube();
    if (!youtube) return { videos: [], error: 'YouTube-avain puuttuu. Tallenna se kohdassa Tunnukset.' };
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

  async function showEventDetails(res, id, url) {
    const event = store.getEvent(id);
    if (!event) throw new HttpError(404, 'Tilaisuutta ei löydy.');
    send(
      res,
      200,
      views.eventDetailsPage({
        event,
        settings: store.getSettings(),
        report: buildReport(event, store.getSettings(), config.publicBaseUrl),
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
    const next = text(form, 'next') || '/admin';
    const back = (res, message) => backTo(res, message, next);

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

  // --- Credentials saved in the admin view (encrypted at rest, see secrets.js) ---

  const oauthStates = new Map();
  const STATE_TTL_MS = 10 * 60_000;
  const redirectUri = `${config.publicBaseUrl}/admin/oauth/callback`;

  function requireSecrets() {
    if (!secrets || !credentials) {
      throw new HttpError(503, 'Tunnusten tallennus ei ole käytössä: aseta SECRETS_KEY ja käynnistä palvelu uudelleen.');
    }
  }

  function showCredentials(res, url) {
    send(
      res,
      200,
      views.credentialsPage({
        status: credentials ? credentials.status() : null,
        canStore: Boolean(secrets),
        redirectUri,
        channelIds: config.youtubeChannelIds,
        flash: url.searchParams.get('msg') ?? '',
        settings: store.getSettings(),
      }),
    );
  }

  const toCredentials = (res, message) => redirect(res, `/admin/credentials?msg=${encodeURIComponent(message)}`);

  // An empty secret field keeps the stored secret, so the note can be edited alone.
  async function saveCredential(res, name, form) {
    requireSecrets();
    const existing = secrets.get(name);
    const note = text(form, 'note').slice(0, 500);
    const pick = (field) => text(form, field) || existing?.fields?.[field] || '';
    let fields;
    if (name === 'oauthClient') {
      fields = { clientId: pick('clientId'), clientSecret: pick('clientSecret') };
      if (!fields.clientId || !fields.clientSecret) throw new HttpError(400, 'Asiakastunnus ja salaisuus vaaditaan.');
    } else {
      fields = { apiKey: pick('apiKey') };
      if (!fields.apiKey) throw new HttpError(400, 'Avain puuttuu.');
    }
    await secrets.set(name, { fields, note, meta: existing?.meta ?? {} });
    toCredentials(res, 'Tunnus tallennettu.');
  }

  async function startOAuth(res) {
    requireSecrets();
    const { clientId } = credentials.values('oauthClient').fields;
    if (!clientId) throw new HttpError(400, 'Tallenna ensin OAuth-asiakkaan tunnus ja salaisuus.');
    const now = Date.now();
    for (const [key, at] of oauthStates) if (now - at > STATE_TTL_MS) oauthStates.delete(key);
    const state = randomBytes(18).toString('base64url');
    oauthStates.set(state, now);
    redirect(res, buildConsentUrl({ clientId, redirectUri, state }));
  }

  async function finishOAuth(res, url) {
    requireSecrets();
    const state = url.searchParams.get('state') ?? '';
    const startedAt = oauthStates.get(state);
    oauthStates.delete(state);
    if (!startedAt || Date.now() - startedAt > STATE_TTL_MS) {
      throw new HttpError(400, 'Kirjautuminen vanheni tai pyyntö on virheellinen. Aloita alusta.');
    }
    const code = url.searchParams.get('code');
    if (!code) return toCredentials(res, `Google ei myöntänyt oikeutta: ${url.searchParams.get('error') ?? 'koodi puuttuu'}`);
    const { clientId, clientSecret } = credentials.values('oauthClient').fields;
    try {
      const tokens = await exchangeCode({ clientId, clientSecret, redirectUri, code, fetchImpl });
      if (!tokens.refresh_token) {
        throw new Error('Google ei palauttanut pysyvää tunnusta. Poista sovelluksen käyttöoikeus Google-tililtäsi ja yritä uudelleen.');
      }
      const identity = await fetchIdentity({ accessToken: tokens.access_token, fetchImpl });
      await secrets.set('oauthToken', {
        fields: { refreshToken: tokens.refresh_token },
        note: secrets.get('oauthToken')?.note ?? '',
        meta: identity,
      });
      toCredentials(res, 'YouTube-kirjautuminen tallennettu.');
    } catch (err) {
      toCredentials(res, `Kirjautuminen epäonnistui: ${err.message}`);
    }
  }

  async function adminCredentials(req, res, url, form) {
    if (req.method === 'GET' && url.pathname === '/admin/credentials') return showCredentials(res, url);
    if (req.method === 'GET' && url.pathname === '/admin/oauth/start') return startOAuth(res);
    if (req.method === 'GET' && url.pathname === '/admin/oauth/callback') return finishOAuth(res, url);
    const names = { 'youtube-key': 'youtubeApiKey', 'oauth-client': 'oauthClient', brevo: 'brevoApiKey', 'oauth-token': 'oauthToken' };
    const match = url.pathname.match(/^\/admin\/credentials\/([a-z-]+)(\/delete)?$/);
    const name = match && names[match[1]];
    if (!name || req.method !== 'POST') throw new HttpError(404, 'Sivua ei löydy.');
    if (match[2]) {
      requireSecrets();
      await secrets.remove(name);
      return toCredentials(res, 'Tunnus poistettu.');
    }
    if (name === 'oauthToken') {
      // Only the note of the sign-in can be edited; the token itself comes from the sign-in flow.
      requireSecrets();
      const existing = secrets.get('oauthToken');
      if (!existing) throw new HttpError(404, 'Kirjautumista ei ole.');
      await secrets.set('oauthToken', { fields: existing.fields, note: text(form, 'note').slice(0, 500), meta: existing.meta }, existing.savedAt);
      return toCredentials(res, 'Muistiinpano tallennettu.');
    }
    return saveCredential(res, name, form);
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
    const detailsMatch = url.pathname.match(/^\/admin\/events\/([^/]+)$/);
    if (req.method === 'GET' && detailsMatch) return showEventDetails(res, decodeURIComponent(detailsMatch[1]), url);
    if (url.pathname === '/admin/credentials' || url.pathname.startsWith('/admin/credentials/') || url.pathname.startsWith('/admin/oauth/')) {
      let form = null;
      if (req.method === 'POST') {
        assertSameOrigin(req);
        form = await readForm(req);
      }
      return adminCredentials(req, res, url, form);
    }
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
