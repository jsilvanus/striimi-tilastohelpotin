# Asennus Dockerilla

Palvelu ajetaan julkaistusta kuvasta. Mitään ei käännetä palvelimella, ja asetukset annetaan `.env`-tiedostossa.

Kuva: `ghcr.io/jsilvanus/striimi-tilastohelpotin` (`latest` seuraa `main`-haaraa, lisäksi `sha-<commit>` ja versiotagit `v*`).
Kuva julkaistaan työnkulusta `.github/workflows/publish-image.yml`, kun muutokset yhdistetään `main`-haaraan.
Jos paketti on yksityinen, kirjaudu ensin: `docker login ghcr.io` (käyttäjä ja `read:packages`-oikeuden token).

## 1. Valmistelu

Tarvitset Docker Compose 2.24 tai uudemman.

```sh
mkdir striimitilastot && cd striimitilastot
curl -O https://raw.githubusercontent.com/jsilvanus/striimi-tilastohelpotin/main/compose.yml
curl -O https://raw.githubusercontent.com/jsilvanus/striimi-tilastohelpotin/main/compose.traefik.yml
curl -o .env https://raw.githubusercontent.com/jsilvanus/striimi-tilastohelpotin/main/.env.example
chmod 600 .env
```

Täytä `.env`:

| Muuttuja | Mitä |
| --- | --- |
| `PUBLIC_BASE_URL` | Julkinen osoite, esim. `https://tilastot.example.fi`. Käytetään raporttien linkeissä ja Google-kirjautumisen paluuosoitteessa |
| `ADMIN_PASSWORD` | Ylläpidon salasana. Ilman sitä ylläpito on pois käytöstä |
| `SECRETS_KEY` | Satunnainen merkkijono, esim. `openssl rand -base64 36`. Salaa ylläpidossa tallennetut tunnukset. **Säilytä kopio muualla**: jos se katoaa, tunnukset syötetään uudelleen |
| `YOUTUBE_CHANNEL_IDS` | Seurattavat kanavat (alkavat `UC`), pilkuilla erotettuna |

YouTube-avain, OAuth-asiakas ja Brevo-avain voi antaa joko `.env`-tiedostossa tai vasta käynnistyksen jälkeen sivulla
`/admin/credentials` (suositus: ne tallentuvat salattuina, ja muistiinpano kertoo, kenen tunnus on käytössä).

## 2. Käynnistys (vain paikallinen silmukka)

```sh
docker compose up -d
docker compose logs -f app
```

Palvelu kuuntelee osoitetta `127.0.0.1:8095` eikä näy verkkoon. Kokeile: `curl http://127.0.0.1:8095/health` palauttaa `ok`.
Portin voi vaihtaa muuttujalla `HOST_PORT` (`.env`). Julkinen käyttö vaatii käänteisen välityspalvelimen (esim. Traefik alla,
tai oma nginx, joka ohjaa osoitteeseen `127.0.0.1:8095`).

Tiedot (`store.json` ja salattu `secrets.enc.json`) ovat Dockerin volumessa `data`.

## 3. Traefik

Kun Traefik on jo käynnissä samalla koneella ja sillä on Docker-palveluntarjoaja, ota overlay käyttöön:

```sh
# .env: APP_HOST=tilastot.example.fi
docker compose -f compose.yml -f compose.traefik.yml up -d
```

Overlay poistaa porttijulkaisun, liittää palvelun Traefikin verkkoon ja asettaa reitityksen osoitteelle `APP_HOST`.
Oletusnimet voi vaihtaa `.env`-tiedostossa, jos Traefikisi käyttää muita:

| Muuttuja | Oletus |
| --- | --- |
| `TRAEFIK_NETWORK` | `traefik` (ulkoinen Docker-verkko) |
| `TRAEFIK_ENTRYPOINT` | `websecure` |
| `TRAEFIK_CERTRESOLVER` | `letsencrypt` |

Osoitteen `/admin` suojaa vain ylläpidon salasana (HTTP Basic), joten käytä sitä vain TLS:n kautta. Julkinen lomake on
osoitteessa `/e/<tunnus>`. Halutessasi voit rajata `/admin` Traefikin middlewarella verkon osoitteisiin.

## 4. Google-kirjautuminen (Analytics)

1. Luo Google Cloud -projektiin OAuth-asiakas (verkkosovellus) ja ota käyttöön YouTube Analytics API ja YouTube Data API.
2. Lisää sallituksi uudelleenohjausosoitteeksi `<PUBLIC_BASE_URL>/admin/oauth/callback`.
3. Tallenna asiakkaan tunnus ja salaisuus sivulla `/admin/credentials` ja paina "Kirjaudu Googleen" kanavan omistajan tai ylläpitäjän tilillä.

## 5. Päivitys ja varmuuskopio

```sh
docker compose pull && docker compose up -d     # tai kiinnitä versio: IMAGE_TAG=sha-abc1234
```

Varmuuskopioi volume `data` ja `.env`:

```sh
docker run --rm -v striimi-tilastohelpotin_data:/data -v "$PWD":/backup alpine tar czf /backup/data.tgz -C /data .
```

Lomakkeet ja niiden yhteystiedot poistuvat automaattisesti viikon kuluttua raportin lähettämisestä, joten vanhaa varmuuskopiota ei kannata palauttaa
ilman tarvetta.

## Ei vielä kokeiltu

Kuvan rakennusta ja Compose-tiedostoja ei ole ajettu oikealla Dockerilla tässä ympäristössä (vain `docker compose config`
-tarkistus). Kokeile ensimmäinen asennus ennen kuin luotat siihen.
