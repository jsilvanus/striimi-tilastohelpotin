import { createAnalyticsClient } from './analytics.js';
import { createMailer } from './brevo.js';
import { createTokenProvider } from './oauth.js';
import { createYouTubeClient } from './youtube.js';

export const SECRET_NAMES = ['youtubeApiKey', 'oauthClient', 'oauthToken', 'brevoApiKey'];

// The main secret of each entry, used for the "ends in …" hint.
const PRIMARY_FIELD = {
  youtubeApiKey: 'apiKey',
  oauthClient: 'clientSecret',
  oauthToken: 'refreshToken',
  brevoApiKey: 'apiKey',
};

export function maskSecret(value) {
  const text = String(value ?? '');
  return text.length > 8 ? `••••${text.slice(-4)}` : '••••';
}

// Resolves the credentials in use: ones saved in the admin view win over environment variables.
// The clients are rebuilt only when the values they were built from change, so saving a new
// credential takes effect on the next call without a restart.
export function createCredentials({ config, secrets = null, fetchImpl = fetch }) {
  const cache = new Map();

  function cached(name, signature, build) {
    const hit = cache.get(name);
    if (hit && hit.signature === (signature || '')) return hit.client;
    const client = signature ? build() : null;
    cache.set(name, { signature: signature || '', client });
    return client;
  }

  function values(name) {
    const stored = secrets?.get(name);
    if (stored) return { source: 'ui', fields: stored.fields, entry: stored };
    const env = {
      youtubeApiKey: { apiKey: config.youtubeApiKey },
      oauthClient: { clientId: config.oauth?.clientId, clientSecret: config.oauth?.clientSecret },
      oauthToken: { refreshToken: config.oauth?.refreshToken },
      brevoApiKey: { apiKey: config.brevoApiKey },
    }[name];
    const primary = env[PRIMARY_FIELD[name]];
    return primary ? { source: 'env', fields: env, entry: null } : { source: 'none', fields: {}, entry: null };
  }

  return {
    values,
    youtube() {
      const { apiKey } = values('youtubeApiKey').fields;
      return cached('youtube', apiKey, () => createYouTubeClient({ apiKey, fetchImpl }));
    },
    mailer() {
      const { apiKey } = values('brevoApiKey').fields;
      return cached('mailer', apiKey, () => createMailer({ apiKey, fetchImpl }));
    },
    analytics() {
      const { clientId, clientSecret } = values('oauthClient').fields;
      const { refreshToken } = values('oauthToken').fields;
      const signature = clientId && clientSecret && refreshToken ? [clientId, clientSecret, refreshToken].join('\n') : '';
      return cached('analytics', signature, () =>
        createAnalyticsClient({
          tokenProvider: createTokenProvider({ clientId, clientSecret, refreshToken, fetchImpl }),
          fetchImpl,
        }),
      );
    },
    // What the admin page may show: never the secret itself, only where it comes from and its tail.
    status() {
      return Object.fromEntries(
        SECRET_NAMES.map((name) => {
          const { source, fields, entry } = values(name);
          return [
            name,
            {
              source,
              configured: source !== 'none',
              hint: source === 'none' ? '' : maskSecret(fields[PRIMARY_FIELD[name]]),
              clientId: name === 'oauthClient' ? (fields.clientId ?? '') : undefined,
              note: entry?.note ?? '',
              savedAt: entry?.savedAt ?? null,
              meta: entry?.meta ?? {},
            },
          ];
        }),
      );
    },
  };
}
