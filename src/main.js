import { createServer } from 'node:http';
import { createMailer } from './brevo.js';
import { loadConfig } from './config.js';
import { DEFAULT_SETTINGS } from './domain.js';
import { createApp } from './server.js';
import { createStore } from './store.js';
import { createTracker } from './tracker.js';
import { createYouTubeClient } from './youtube.js';

const config = loadConfig();

const store = await createStore({
  file: config.dataFile,
  defaults: { ...DEFAULT_SETTINGS, ...config.defaultSettings },
});
const youtube = config.youtubeApiKey ? createYouTubeClient({ apiKey: config.youtubeApiKey }) : null;
const mailer = config.brevoApiKey ? createMailer({ apiKey: config.brevoApiKey }) : null;
const tracker = createTracker({ config, store, youtube, mailer });

tracker.start(config.pollIntervalSeconds * 1000);

const server = createServer(createApp({ config, store, tracker, youtube }));
server.listen(config.port, () => {
  console.log(`Tilastopalvelu käynnissä portissa ${config.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    tracker.stop();
    server.close(() => process.exit(0));
  });
}
