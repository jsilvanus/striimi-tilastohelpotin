# striimi-tilastohelpotin

Kirkon nettistriimien osallistujien tilastoinnin helpottaja.

Palvelu seuraa seurakunnan YouTube-kanavia, kerää verkkolomakkeilla ilmoitetut ryhmäkatsojat
ja lähettää tilaisuuden päätyttyä raporttipyynnön sähköpostitse (Brevo).

## Ominaisuudet

- **Striimien ja videoiden seuranta.** Palvelu löytää seurakunnan kanavilta live- ja tulevat striimit
  automaattisesti. Julkaistut videot listataan ylläpitonäkymässä, josta ne voi ottaa seurantaan.
- **Samanaikaisten katsojien näytteenotto.** Käynnissä olevasta striimistä otetaan näyte minuutin välein.
- **Laskentatavat.** Samanaikaisten katsojien enimmäismäärä, keskiarvo (katseluaika jaettuna kestolla)
  tai katselukerrat yhteensä. Tapa valitaan jokaiselle tilaisuudelle erikseen.
- **Verkkolomake.** Osoite on `/e/<videoId>` (YouTube) tai satunnainen linkki (manuaalinen).
  Sivulla näkyvät logo, tilaisuuden nimi, upotettu video ja lomake: ryhmän nimi tai nimimerkki,
  katsojamäärä ja valinnainen yhteystieto.
- **Manuaaliset linkit.** Muita kuin YouTube-lähetyksiä varten ylläpito voi luoda linkin, jolle annetaan
  osoite ja päättymisaika.
- **Raportti.** Päättymisen jälkeen (tyypin mukaan: jumalanpalvelus 48 h, kirkollinen toimitus heti,
  muu 24 h) palvelu lähettää Brevon kautta sähköpostin. Pohjan tagit: `[EVENT NAME]`, `[EVENT URL]`,
  `[SUMMARY]`, `[FILLED FORMS]`, `[YOUTUBE COUNTS]`.

## Tietosuoja

- Lomakkeelle kerätään vain ryhmän nimi tai nimimerkki ja katsojamäärä. Yhteystieto on vapaaehtoinen.
- Yhteystiedot poistetaan, kun raportti on lähetetty. Niitä ei lisätä raporttiin.
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
| `POLL_INTERVAL_SECONDS` | Seurantakierroksen väli (oletus 60) |
| `ADMIN_PASSWORD` | Ylläpitonäkymän salasana (Basic-autentikointi, käyttäjänimi mikä tahansa). Ilman sitä ylläpito on pois käytöstä |
| `BREVO_API_KEY` | Brevo-API-avain raporttien lähettämiseen |
| `PARISH_NAME` | Seurakunnan nimi (oletusasetus, muutettavissa ylläpidossa) |
| `PARISH_LOGO_URL` | Seurakunnan logon https-osoite (oletusasetus) |

### YouTube Analytics (OAuth)

Raportin lopulliset luvut (samanaikaisten katsojien enimmäismäärä ja keskiarvo) haetaan
YouTube Analytics -rajapinnasta. Se vaatii kanavan omistajan tai ylläpitäjän suostumuksen:

1. Luo Google Cloud -projektiin OAuth-asiakas, ja lisää sen sallituksi uudelleenohjausosoitteeksi
   `http://localhost:8787/oauth2callback`. Ota käyttöön YouTube Analytics API.
2. Aja `YOUTUBE_OAUTH_CLIENT_ID=... YOUTUBE_OAUTH_CLIENT_SECRET=... npm run oauth-setup`, avaa tulostettu
   osoite ja hyväksy käyttöoikeus seurakunnan kanavan tilille.
3. Tallenna tulostettu `YOUTUBE_OAUTH_REFRESH_TOKEN` palvelun ympäristömuuttujiin.

Jos Analytics-haku epäonnistuu tai dataa ei vielä ole, raportti käyttää tilaisuuden aikana otettuja näytteitä.

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
