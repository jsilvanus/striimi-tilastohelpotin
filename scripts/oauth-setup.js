// One-time setup: grants read access to the parish channel's YouTube Analytics and prints a refresh token.
// Usage: YOUTUBE_OAUTH_CLIENT_ID=... YOUTUBE_OAUTH_CLIENT_SECRET=... node scripts/oauth-setup.js
// The redirect URI http://localhost:8787/oauth2callback must be allowed for the OAuth client.
import { createServer } from 'node:http';
import { buildConsentUrl, exchangeCode } from '../src/oauth.js';

const PORT = 8787;
const redirectUri = `http://localhost:${PORT}/oauth2callback`;
const clientId = process.env.YOUTUBE_OAUTH_CLIENT_ID;
const clientSecret = process.env.YOUTUBE_OAUTH_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error('Aseta YOUTUBE_OAUTH_CLIENT_ID ja YOUTUBE_OAUTH_CLIENT_SECRET.');
  process.exit(1);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, redirectUri);
  if (url.pathname !== '/oauth2callback') {
    res.writeHead(404).end();
    return;
  }
  try {
    const code = url.searchParams.get('code');
    if (!code) throw new Error(url.searchParams.get('error') ?? 'Koodi puuttuu.');
    const tokens = await exchangeCode({ clientId, clientSecret, redirectUri, code });
    if (!tokens.refresh_token) {
      throw new Error('Google ei palauttanut refresh_token-arvoa. Poista sovelluksen käyttöoikeus tililtäsi ja yritä uudelleen.');
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('Valmis. Voit sulkea tämän ikkunan.');
    console.log(`\nYOUTUBE_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}\n`);
  } catch (err) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(err.message);
    console.error(err.message);
  } finally {
    server.close();
  }
});

server.listen(PORT, () => {
  console.log('Avaa seuraava osoite selaimessa ja hyväksy käyttöoikeus seurakunnan YouTube-kanavan tilille:\n');
  console.log(buildConsentUrl({ clientId, redirectUri }));
});
