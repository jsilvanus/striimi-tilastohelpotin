const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const ANALYTICS_SCOPE = 'https://www.googleapis.com/auth/yt-analytics.readonly';
// Analytics for the numbers; youtube.readonly and email only to show which channel and account signed in.
export const SCOPES = [
  ANALYTICS_SCOPE,
  'https://www.googleapis.com/auth/youtube.readonly',
  'openid',
  'email',
].join(' ');

async function postToken(fetchImpl, params) {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`Google token request failed with ${res.status}: ${body}`);
  }
  return res.json();
}

export function buildConsentUrl({ clientId, redirectUri, scope = SCOPES, state }) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  const params = {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    access_type: 'offline',
    prompt: 'consent',
  };
  if (state) params.state = state;
  url.search = new URLSearchParams(params).toString();
  return url.toString();
}

export function exchangeCode({ clientId, clientSecret, redirectUri, code, fetchImpl = fetch }) {
  return postToken(fetchImpl, {
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
}

// Access tokens last about an hour; the refresh token is long-lived and is stored in config.
export function createTokenProvider({ clientId, clientSecret, refreshToken, fetchImpl = fetch, now = () => Date.now() }) {
  let cached = null;
  return {
    async getAccessToken() {
      if (cached && now() < cached.expiresAt - 60_000) return cached.token;
      const data = await postToken(fetchImpl, {
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      });
      cached = { token: data.access_token, expiresAt: now() + data.expires_in * 1000 };
      return cached.token;
    },
  };
}

// Which channel and Google account the token belongs to, for the admin page. Failures are not fatal.
export async function fetchIdentity({ accessToken, fetchImpl = fetch }) {
  const headers = { authorization: `Bearer ${accessToken}` };
  const identity = { channelId: null, channelTitle: null, email: null };
  try {
    const res = await fetchImpl('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers });
    if (res.ok) {
      const channel = (await res.json()).items?.[0];
      identity.channelId = channel?.id ?? null;
      identity.channelTitle = channel?.snippet?.title ?? null;
    }
  } catch {
    // The token is still valid without it.
  }
  try {
    const res = await fetchImpl('https://openidconnect.googleapis.com/v1/userinfo', { headers });
    if (res.ok) identity.email = (await res.json()).email ?? null;
  } catch {
    // Same here.
  }
  return identity;
}
