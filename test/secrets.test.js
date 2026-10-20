import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCredentials, maskSecret } from '../src/credentials.js';
import { createSecretStore } from '../src/secrets.js';

const dir = () => mkdtemp(join(tmpdir(), 'secrets-'));

test('secrets are encrypted on disk and read back with the same key', async () => {
  const file = join(await dir(), 'secrets.enc.json');
  const store = await createSecretStore({ file, key: 'testiavain' });
  await store.set('youtubeApiKey', { fields: { apiKey: 'AIza-salainen-arvo' }, note: 'Juhan tunnus' });

  const raw = await readFile(file, 'utf8');
  assert.ok(!raw.includes('AIza-salainen-arvo'));
  assert.ok(!raw.includes('Juhan tunnus'));
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  const reopened = await createSecretStore({ file, key: 'testiavain' });
  assert.equal(reopened.get('youtubeApiKey').fields.apiKey, 'AIza-salainen-arvo');
  assert.equal(reopened.get('youtubeApiKey').note, 'Juhan tunnus');
});

test('a wrong key does not open the file', async () => {
  const file = join(await dir(), 'secrets.enc.json');
  const store = await createSecretStore({ file, key: 'oikea' });
  await store.set('brevoApiKey', { fields: { apiKey: 'x' } });
  await assert.rejects(createSecretStore({ file, key: 'väärä' }), /SECRETS_KEY/);
});

test('a removed secret is gone from the file', async () => {
  const file = join(await dir(), 'secrets.enc.json');
  const store = await createSecretStore({ file, key: 'k' });
  await store.set('brevoApiKey', { fields: { apiKey: 'x' } });
  await store.remove('brevoApiKey');
  assert.equal((await createSecretStore({ file, key: 'k' })).get('brevoApiKey'), null);
});

test('saved credentials win over env and the status never contains the secret', async () => {
  const secrets = await createSecretStore({ file: null, key: 'k' });
  const config = { youtubeApiKey: 'ENV-KEY-1234', oauth: {}, brevoApiKey: '' };
  const credentials = createCredentials({ config, secrets });

  assert.equal(credentials.status().youtubeApiKey.source, 'env');
  assert.equal(credentials.status().brevoApiKey.configured, false);
  assert.equal(credentials.mailer(), null);

  await secrets.set('youtubeApiKey', { fields: { apiKey: 'UI-KEY-98765432' }, note: 'muistio' });
  const status = credentials.status();
  assert.equal(status.youtubeApiKey.source, 'ui');
  assert.equal(status.youtubeApiKey.hint, '••••5432');
  assert.equal(status.youtubeApiKey.note, 'muistio');
  assert.ok(!JSON.stringify(status).includes('UI-KEY-9876'));
  assert.ok(credentials.youtube());

  await secrets.remove('youtubeApiKey');
  assert.equal(credentials.status().youtubeApiKey.source, 'env');
});

test('analytics needs client, secret and token together', async () => {
  const secrets = await createSecretStore({ file: null, key: 'k' });
  const credentials = createCredentials({ config: { oauth: {} }, secrets });
  await secrets.set('oauthClient', { fields: { clientId: 'id', clientSecret: 'sec' } });
  assert.equal(credentials.analytics(), null);
  await secrets.set('oauthToken', { fields: { refreshToken: 'rt' } });
  assert.ok(credentials.analytics());
});

test('maskSecret shows only the tail of long values', () => {
  assert.equal(maskSecret('abcdefghijkl'), '••••ijkl');
  assert.equal(maskSecret('abc'), '••••');
});
