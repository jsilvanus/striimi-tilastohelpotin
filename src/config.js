const splitList = (value = '') =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT ?? 3000),
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
    dataFile: env.DATA_FILE ?? 'data/store.json',
    youtubeApiKey: env.YOUTUBE_API_KEY ?? '',
    youtubeChannelIds: splitList(env.YOUTUBE_CHANNEL_IDS),
    oauth: {
      clientId: env.YOUTUBE_OAUTH_CLIENT_ID ?? '',
      clientSecret: env.YOUTUBE_OAUTH_CLIENT_SECRET ?? '',
      refreshToken: env.YOUTUBE_OAUTH_REFRESH_TOKEN ?? '',
    },
    pollIntervalSeconds: Number(env.POLL_INTERVAL_SECONDS ?? 60),
    secretsKey: env.SECRETS_KEY ?? '',
    secretsFile: env.SECRETS_FILE ?? 'data/secrets.enc.json',
    adminPassword: env.ADMIN_PASSWORD ?? '',
    brevoApiKey: env.BREVO_API_KEY ?? '',
    defaultSettings: {
      parishName: env.PARISH_NAME ?? '',
      parishLogoUrl: env.PARISH_LOGO_URL ?? '',
    },
  };
}
