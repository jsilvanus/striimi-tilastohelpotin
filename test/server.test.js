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
