# striimi-tilastohelpotin

Kirkon nettistriimien osallistujien tilastoinnin helpottaja.

Palvelu seuraa seurakunnan YouTube-kanavia, kerää verkkolomakkeilla ilmoitetut ryhmäkatsojat
ja lähettää tilaisuuden päätyttyä raporttipyynnön sähköpostitse (Brevo).

## Ominaisuudet

- **Striimien ja videoiden seuranta.** Palvelu löytää seurakunnan kanavilta live- ja tulevat striimit
  automaattisesti. Julkaistut videot listataan ylläpitonäkymässä, josta ne voi ottaa seurantaan.
- **YouTube-kyselyt harvoin.** Kanavaa ja seurattuja videoita kysytään enintään kerran tunnissa sekä vielä kerran juuri ennen raportin lähettämistä (tuoreet katselukerrat). Samanaikaisia katsojia ei seurata lainkaan itse: live-luvut (enimmäismäärä ja keskiarvo) haetaan vain YouTube Analyticsin keräämistä tiedoista raporttia lähetettäessä.
- **Osallistujamäärä.** Yhteensä = live-katsojat + lomakeryhmien katsojat + tallenteen katselut.
  Live-katsojat voi laskea enimmäismäärästä tai keskiarvosta (oletus asetetaan ylläpidossa, yksittäinen
  tilaisuus voi ohittaa sen). Jokainen lomakeryhmä vähentää yhden live-katsojan, koska ryhmän näyttö
  näkyy YouTubessa yhtenä katsojana. Tallenteen katselut lasketaan päättymisestä tallennusajan loppuun:
  jumalanpalvelus: tilaisuuden päivä + 2 päivää (3 kalenteripäivää, suomen aikaa), muu tilaisuus oletuksena
  7 päivää (enintään 21), kirkollinen toimitus ei lainkaan. Raportti lähtee tallennusajan viimeisen päivän
  päättyessä (keskiyö).
- **Verkkolomake.** Osoite on `/e/<videoId>` (YouTube) tai satunnainen linkki (manuaalinen).
  Sivulla näkyvät logo, tilaisuuden nimi, upotettu video ja lomake: ryhmän nimi tai nimimerkki,
  katsojamäärä ja valinnainen yhteystieto.
- **Manuaaliset linkit.** Muita kuin YouTube-lähetyksiä varten ylläpito voi luoda linkin, jolle annetaan
  osoite ja päättymisaika.
- **Raportti.** Tallennusajan päätyttyä (tyypin mukaan, ks. osallistujamäärä) palvelu lähettää Brevon
  kautta sähköpostin. Pohjan tagit: `[EVENT NAME]`, `[EVENT URL]`,
  `[SUMMARY]`, `[FILLED FORMS]`, `[YOUTUBE COUNTS]`.

## Tietosuoja

- Lomakkeelle kerätään vain ryhmän nimi tai nimimerkki ja katsojamäärä. Yhteystieto on vapaaehtoinen.
- Lomakkeet yhteystietoineen säilyvät viikon raportin lähettämisestä, jotta tilastosta vastaava voi ottaa yhteyttä ennen kirjaamista, ja poistetaan sitten. Yhteystietoja ei lisätä raporttisähköpostiin; ne näkyvät ylläpidon tietosivulla.
- Raportin voi lähettää uudelleen tietosivulta. Lomakkeiden poiston jälkeen uudelleenlähetys käyttää ensimmäisen raportin lukuja. Raportoidut luvut jäävät tilaisuuden tietosivulle (`/admin/events/<tunnus>`).
- IP-osoitteita tai muita henkilötietoja ei tallenneta.
- Linkit sulkeutuvat tilaisuuden päätyttyä plus 30 minuuttia.

## Asennus

Vaatii Node.js 22 tai uudemman. Riippuvuuksia ei ole.

```sh
npm test
npm start
```

### Ympäristömuuttujat

| Muuttuja | Kuvaus |
| --- | --- |
| `PORT` | HTTP-portti (oletus 3000) |
| `PUBLIC_BASE_URL` | Julkinen osoite, jota käytetään raporttien linkeissä |
| `DATA_FILE` | JSON-tiedoston polku (oletus `data/store.json`) |
| `YOUTUBE_API_KEY` | YouTube Data API -avain. Ilman sitä YouTube-seuranta on pois päältä |
| `YOUTUBE_CHANNEL_IDS` | Pilkuilla erotettuna seurakunnan kanavien ID:t (alkavat `UC`) |
| `YOUTUBE_OAUTH_CLIENT_ID` | OAuth-asiakkaan tunnus. Tarvitaan YouTube Analytics -tietoihin |
| `YOUTUBE_OAUTH_CLIENT_SECRET` | OAuth-asiakkaan salaisuus |
| `YOUTUBE_OAUTH_REFRESH_TOKEN` | Pitkäikäinen tunnus, jonka saat komennolla `npm run oauth-setup` |
| `SECRETS_KEY` | Pitkä satunnainen merkkijono, jolla ylläpidossa tallennetut tunnukset salataan (AES-256-GCM). Ilman sitä tunnuksia ei voi tallentaa ylläpidossa. Älä tallenna sitä data-hakemistoon; jos se katoaa, tunnukset on syötettävä uudelleen |
| `SECRETS_FILE` | Salattujen tunnusten tiedosto (oletus `data/secrets.enc.json`) |
| `POLL_INTERVAL_SECONDS` | Väli, jolla YouTubelta kysytään (oletus ja vähimmäisarvo 3600). Raportit ja lomakkeiden poisto tarkistetaan minuutin välein ilman YouTube-kutsuja |
| `ADMIN_PASSWORD` | Ylläpitonäkymän salasana (Basic-autentikointi, käyttäjänimi mikä tahansa). Ilman sitä ylläpito on pois käytöstä |
| `BREVO_API_KEY` | Brevo-API-avain raporttien lähettämiseen |
| `PARISH_NAME` | Seurakunnan nimi (oletusasetus, muutettavissa ylläpidossa) |
| `PARISH_LOGO_URL` | Seurakunnan logon https-osoite (oletusasetus) |

Asennus Dockerilla ja Traefik-overlay: [docs/DEPLOY.md](docs/DEPLOY.md).

### Tunnukset ylläpidossa

Sivulla `/admin/credentials` voi tallentaa YouTube Data API -avaimen, OAuth-asiakkaan, Google-kirjautumisen ja
Brevo-avaimen muistiinpanoineen. Tallennettu arvo ei näy enää tallennuksen jälkeen, vain sen neljä viimeistä
merkkiä. Tiedosto on salattu (AES-256-GCM, avain johdetaan `SECRETS_KEY`-arvosta scryptillä) ja sen oikeudet ovat 0600.
Täällä tallennettu tunnus voittaa saman ympäristömuuttujan, ja muutos tulee voimaan ilman uudelleenkäynnistystä.
Google-kirjautuminen tehdään sivulla (`Kirjaudu Googleen`); sivu näyttää, minkä kanavan ja tilin tunnuksella
kirjauduttiin. Lisää OAuth-asiakkaan sallituksi uudelleenohjausosoitteeksi `PUBLIC_BASE_URL` + `/admin/oauth/callback`.
Kirjautuminen pyytää Analytics-lukuoikeuden lisäksi kanavan ja sähköpostin näyttämisen. Ylläpidon salasana
(`ADMIN_PASSWORD`) ja `SECRETS_KEY` ovat ainoat, jotka pysyvät palvelimen ympäristössä.
Ei ole testattu oikeaa Googlea tai Brevoa vasten.

### YouTube Analytics (OAuth)

Raportin lopulliset luvut (samanaikaisten katsojien enimmäismäärä ja keskiarvo) haetaan
YouTube Analytics -rajapinnasta. Se vaatii kanavan omistajan tai ylläpitäjän suostumuksen:

1. Luo Google Cloud -projektiin OAuth-asiakas, ja lisää sen sallituksi uudelleenohjausosoitteeksi
   `http://localhost:8787/oauth2callback`. Ota käyttöön YouTube Analytics API.
2. Aja `YOUTUBE_OAUTH_CLIENT_ID=... YOUTUBE_OAUTH_CLIENT_SECRET=... npm run oauth-setup`, avaa tulostettu
   osoite ja hyväksy käyttöoikeus seurakunnan kanavan tilille.
3. Tallenna tulostettu `YOUTUBE_OAUTH_REFRESH_TOKEN` palvelun ympäristömuuttujiin.

Jos Analytics-haku epäonnistuu tai dataa ei vielä ole, raportissa live-luvut ovat "ei saatavilla". Uudelleenlähetys yrittää hakua uudestaan ja päivittää luvut.

Raportin vastaanottaja, lähettäjän sähköposti (vahvistettu Brevossa) ja sähköpostipohja asetetaan
ylläpitonäkymän asetuksissa osoitteessa `/admin`.

## YouTube-kiintiö

Kanavan videot haetaan `playlistItems`- ja `videos`-kutsuilla (1 yksikkö kutsua kohden), ei `search`-kutsulla,
joka maksaa 100 yksikköä. Kiintiön käyttö pysyy siis pienenä.

## Rajoitukset

- Katseluaikaa (esim. yli minuutin katsomiset) ei vielä lasketa. Samanaikaisten katsojien
  enimmäismäärä ja keskiarvo tulevat Analytics-rajapinnasta, kun OAuth on määritetty.
- Analytics-rajapinnan `livestreamPosition`-dimensiota (aikasarja minuuteittain) ei ole vielä
  otettu käyttöön, koska sen tarkkuutta ei ole testattu.
- Palvelu tallentaa tiedot yhteen JSON-tiedostoon. Se sopii yhdelle prosessille, ei useammalle rinnakkain.
- Sähköpostin lähettäjä on vahvistettava Brevossa, ja raportin vastaanottaja on asetettava ylläpidossa.
