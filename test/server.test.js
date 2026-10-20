import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createEvent, DEFAULT_SETTINGS } from '../src/domain.js';
import { createApp } from '../src/server.js';
import { createStore } from '../src/store.js';
import { createTracker } from '../src/tracker.js';

const ADMIN_PASSWORD = 'salasana-testi';
const auth = `Basic ${Buffer.from(`admin:${ADMIN_PASSWORD}`).toString('base64')}`;

let server;
let base;
let store;

before(async () => {
  store = await createStore({ defaults: { ...DEFAULT_SETTINGS, parishName: 'Testiseurakunta' } });
  const config = { adminPassword: ADMIN_PASSWORD, publicBaseUrl: 'http://localhost', youtubeChannelIds: [] };
  const tracker = createTracker({ config, store, youtube: null, mailer: null });
  await store.putEvent(
    createEvent({
      id: 'manual-open-1',
      source: 'manual',
      title: 'Avoin <tilaisuus>',
      url: 'https://example.org/live',
      eventType: 'other',
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
      createdAt: new Date().toISOString(),
    }),
  );
  await store.putEvent(
    createEvent({
      id: 'manual-closed-1',
      source: 'manual',
      title: 'Suljettu tilaisuus',
      url: 'https://example.org/old',
      endsAt: '2020-01-01T10:00:00.000Z',
      createdAt: '2020-01-01T09:00:00.000Z',
    }),
  );
  server = createServer(createApp({ config, store, tracker, youtube: null }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const post = (path, body, headers = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body),
  });

test('the public page shows the escaped title and the form', async () => {
  const res = await fetch(`${base}/e/manual-open-1`);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /Avoin &lt;tilaisuus&gt;/);
  assert.doesNotMatch(html, /Avoin <tilaisuus>/);
  assert.match(html, /name="groupName"/);
  assert.match(html, /Testiseurakunta/);
});

test('a valid submission is stored without contact details in the response', async () => {
  const res = await post('/e/manual-open-1', { groupName: 'Nuorten ryhmä', watchers: '7', contactEmail: '' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/e/manual-open-1?saved=1');
  const event = store.getEvent('manual-open-1');
  assert.equal(event.submissions.length, 1);
  assert.equal(event.submissions[0].watchers, 7);
  assert.equal(event.submissions[0].contactEmail, null);
});

test('invalid submissions are rejected with the form shown again', async () => {
  const res = await post('/e/manual-open-1', { groupName: '', watchers: '0', contactEmail: 'ei-sahkoposti' });
  assert.equal(res.status, 422);
  const html = await res.text();
  assert.match(html, /ryhmän nimi/);
  assert.match(html, /Katsojamäärän/);
  assert.equal(store.getEvent('manual-open-1').submissions.length, 1);
});

test('a closed event shows the closed notice and rejects submissions', async () => {
  const page = await fetch(`${base}/e/manual-closed-1`);
  assert.equal(page.status, 410);
  assert.match(await page.text(), /päättynyt/);

  const res = await post('/e/manual-closed-1', { groupName: 'Myöhässä', watchers: '3' });
  assert.equal(res.status, 410);
  assert.equal(store.getEvent('manual-closed-1').submissions.length, 0);
});

test('unknown links return 404', async () => {
  const res = await fetch(`${base}/e/no-such-link`);
  assert.equal(res.status, 404);
});

test('the admin area requires the admin password', async () => {
  const res = await fetch(`${base}/admin`);
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate'), /Basic/);

  const wrong = await fetch(`${base}/admin`, {
    headers: { authorization: `Basic ${Buffer.from('admin:väärin').toString('base64')}` },
  });
  assert.equal(wrong.status, 401);

  const ok = await fetch(`${base}/admin`, { headers: { authorization: auth } });
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /Uusi manuaalinen linkki/);
});

test('admin actions reject cross-origin posts', async () => {
  const res = await post(
    '/admin/events/manual-open-1',
    { action: 'close' },
    { authorization: auth, origin: 'https://evil.example' },
  );
  assert.equal(res.status, 403);
  assert.equal(store.getEvent('manual-open-1').enabled, true);
});

test('admin can close a link now, which stops submissions', async () => {
  const res = await post('/admin/events/manual-open-1', { action: 'close' }, { authorization: auth });
  assert.equal(res.status, 303);
  assert.ok(new Date(store.getEvent('manual-open-1').endsAt) <= new Date());
  const page = await fetch(`${base}/e/manual-open-1`);
  assert.equal(page.status, 410);
});

test('admin can create a manual link that needs an end time and an https address', async () => {
  const missingEnd = await post(
    '/admin/events/manual',
    { title: 'Ilman loppua', url: 'https://example.org', eventType: 'other', endsAt: '' },
    { authorization: auth },
  );
  assert.equal(missingEnd.status, 400);

  const created = await post(
    '/admin/events/manual',
    { title: 'Uusi linkki', url: 'https://example.org/uusi', eventType: 'worship', endsAt: '2099-10-19T18:00' },
    { authorization: auth },
  );
  assert.equal(created.status, 303);
  const event = store.listEvents().find((e) => e.title === 'Uusi linkki');
  assert.equal(event.eventType, 'worship');
  assert.equal(event.endsAt, '2099-10-19T15:00:00.000Z');
});

// --- Credentials page ---

async function credentialsApp({ withSecrets = true, fetchImpl } = {}) {
  const { createSecretStore } = await import('../src/secrets.js');
  const { createCredentials } = await import('../src/credentials.js');
  const secrets = withSecrets ? await createSecretStore({ file: null, key: 'k' }) : null;
  const config = {
    adminPassword: ADMIN_PASSWORD,
    publicBaseUrl: 'http://app.test',
    youtubeChannelIds: ['UCmatch'],
    oauth: {},
  };
  const credentials = createCredentials({ config, secrets });
  const credStore = await createStore({ defaults: DEFAULT_SETTINGS });
  const tracker = createTracker({ config, store: credStore, youtube: null, mailer: null });
  const app = createServer(createApp({ config, store: credStore, tracker, credentials, secrets, fetchImpl }));
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.address().port}`;
  const call = (path, body) =>
    fetch(`${url}${path}`, {
      method: body ? 'POST' : 'GET',
      redirect: 'manual',
      headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
      body: body ? new URLSearchParams(body) : undefined,
    });
  return { app, call, secrets };
}

test('the event details page lists the forms and the numbers, and can send the report', async () => {
  store.getEvent('manual-open-1').submissions.push({ id: 'det1', groupName: 'Lomakeryhmä', watchers: 4, contactEmail: null, createdAt: new Date().toISOString() });
  const res = await fetch(`${base}/admin/events/manual-open-1`, { headers: { authorization: auth } });
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /Lomakeryhmä/);
  assert.match(html, /Osallistujat yhteensä/);
  assert.match(html, /Raportin esikatselu/);
  assert.match(html, /Lähetä raportti nyt/);
  assert.equal((await fetch(`${base}/admin/events/ei-ole`, { headers: { authorization: auth } })).status, 404);

  const closed = await post('/admin/events/manual-open-1', { action: 'close', next: '/admin/events/manual-open-1' }, { authorization: auth });
  assert.equal(closed.status, 303);
  assert.match(closed.headers.get('location'), /^\/admin\/events\/manual-open-1\?msg=/);
  const evil = await post('/admin/events/manual-open-1', { action: 'close', next: '//evil.example' }, { authorization: auth });
  assert.match(evil.headers.get('location'), /^\/admin\?msg=/);
});

test('the credentials page needs the admin login', async () => {
  const { app } = await credentialsApp();
  const res = await fetch(`http://127.0.0.1:${app.address().port}/admin/credentials`);
  assert.equal(res.status, 401);
  app.close();
});

test('a saved API key is shown only as its tail, with the note', async () => {
  const { app, call, secrets } = await credentialsApp();
  const res = await call('/admin/credentials/youtube-key', { apiKey: 'AIza-hyvin-salainen-1234', note: 'Seurakunnan projekti' });
  assert.equal(res.status, 303);
  assert.equal(secrets.get('youtubeApiKey').fields.apiKey, 'AIza-hyvin-salainen-1234');

  const html = await (await call('/admin/credentials')).text();
  assert.match(html, /••••1234/);
  assert.match(html, /Seurakunnan projekti/);
  assert.doesNotMatch(html, /hyvin-salainen/);

  // Editing only the note keeps the key.
  await call('/admin/credentials/youtube-key', { apiKey: '', note: 'Uusi muistio' });
  assert.equal(secrets.get('youtubeApiKey').fields.apiKey, 'AIza-hyvin-salainen-1234');
  assert.equal(secrets.get('youtubeApiKey').note, 'Uusi muistio');

  await call('/admin/credentials/youtube-key/delete', {});
  assert.equal(secrets.get('youtubeApiKey'), null);
  app.close();
});

test('without SECRETS_KEY saving is refused', async () => {
  const { app, call } = await credentialsApp({ withSecrets: false });
  assert.equal((await call('/admin/credentials/brevo', { apiKey: 'x' })).status, 503);
  assert.match(await (await call('/admin/credentials')).text(), /SECRETS_KEY/);
  app.close();
});

test('the Google sign-in stores the token and shows who signed in', async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    requests.push(href);
    const json = (data) => new Response(JSON.stringify(data), { status: 200 });
    if (href.includes('oauth2.googleapis.com/token')) return json({ access_token: 'at', refresh_token: 'RT-secret-9999', expires_in: 3600 });
    if (href.includes('/youtube/v3/channels')) return json({ items: [{ id: 'UCother', snippet: { title: 'Testikanava' } }] });
    if (href.includes('userinfo')) return json({ email: 'admin@example.org' });
    throw new Error(`unexpected ${href}`);
  };
  const { app, call, secrets } = await credentialsApp({ fetchImpl });
  await call('/admin/credentials/oauth-client', { clientId: 'cid', clientSecret: 'csecret' });

  const start = await call('/admin/oauth/start');
  assert.equal(start.status, 303);
  const consent = new URL(start.headers.get('location'));
  assert.equal(consent.searchParams.get('redirect_uri'), 'http://app.test/admin/oauth/callback');
  const state = consent.searchParams.get('state');

  const bad = await call('/admin/oauth/callback?code=c&state=wrong');
  assert.equal(bad.status, 400);

  const done = await call(`/admin/oauth/callback?code=c&state=${state}`);
  assert.equal(done.status, 303);
  assert.equal(secrets.get('oauthToken').fields.refreshToken, 'RT-secret-9999');

  const html = await (await call('/admin/credentials')).text();
  assert.match(html, /Testikanava/);
  assert.match(html, /admin@example\.org/);
  assert.match(html, /ei ole seurattavien kanavien listalla/);
  assert.doesNotMatch(html, /RT-secret/);

  // The state is single-use.
  assert.equal((await call(`/admin/oauth/callback?code=c&state=${state}`)).status, 400);
  app.close();
});
