import { createServer } from 'node:http';
import { createCredentials } from './credentials.js';
import { loadConfig } from './config.js';
import { DEFAULT_SETTINGS } from './domain.js';
import { createApp } from './server.js';
import { createSecretStore } from './secrets.js';
import { createStore } from './store.js';
import { createTracker } from './tracker.js';

const config = loadConfig();

const store = await createStore({
  file: config.dataFile,
  defaults: { ...DEFAULT_SETTINGS, ...config.defaultSettings },
});
// Credentials saved in the admin view are encrypted with SECRETS_KEY; without it only env variables are used.
const secrets = config.secretsKey ? await createSecretStore({ file: config.secretsFile, key: config.secretsKey }) : null;
const credentials = createCredentials({ config, secrets });
const youtube = () => credentials.youtube();
const tracker = createTracker({
  config,
  store,
  youtube,
  analytics: () => credentials.analytics(),
  mailer: () => credentials.mailer(),
});

tracker.start(config.pollIntervalSeconds * 1000);

const server = createServer(createApp({ config, store, tracker, youtube, credentials, secrets }));
server.listen(config.port, () => {
  console.log(`Tilastopalvelu käynnissä portissa ${config.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    tracker.stop();
    server.close(() => process.exit(0));
  });
}
