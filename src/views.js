import {
  COUNTING_SCHEMES,
  EVENT_TYPES,
  FORM_RETENTION_DAYS,
  MAX_VOD_DAYS,
  TEMPLATE_KEYS,
  estimateParticipants,
  eventStatus,
  formatDateTime,
  formsPurgeAt,
  liveModelOf,
  reportAt,
  vodDaysOf,
  toLocalInput,
} from './domain.js';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

const STYLE = `
:root { color-scheme: light dark; --fg: #1d1d1f; --bg: #fafaf7; --card: #fff; --accent: #1f4e79; --muted: #666; --border: #d8d8d0; }
@media (prefers-color-scheme: dark) {
  :root { --fg: #eee; --bg: #161616; --card: #222; --accent: #8ab4e8; --muted: #aaa; --border: #444; }
}
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
.top { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.top img { height: 48px; }
main { max-width: 760px; margin: 0 auto; padding: 16px; }
h1 { font-size: 1.6rem; }
.video { position: relative; aspect-ratio: 16 / 9; margin-bottom: 16px; }
.video iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
.stack { display: flex; flex-direction: column; gap: 12px; }
label { display: flex; flex-direction: column; gap: 4px; }
input, select, textarea, button { font: inherit; padding: 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--card); color: var(--fg); max-width: 100%; }
textarea { min-height: 180px; }
button { background: var(--accent); color: #fff; cursor: pointer; }
button.secondary { background: transparent; color: var(--accent); border-color: var(--accent); }
a { color: var(--accent); }
.card { border: 1px solid var(--border); border-radius: 8px; padding: 12px; background: var(--card); margin-bottom: 12px; }
.card h3 { margin: 0 0 4px; font-size: 1.1rem; }
.notice { padding: 10px; border: 1px solid var(--border); border-radius: 6px; }
.notice.ok { border-color: #2e7d32; }
.errors { color: #b00020; padding-left: 20px; margin: 0; }
.grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
.actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: end; }
.check { flex-direction: row; align-items: center; }
.meta, .privacy { color: var(--muted); font-size: 14px; }
.badge { font-size: 13px; border: 1px solid var(--border); border-radius: 999px; padding: 2px 8px; margin-left: 6px; }
section { margin-top: 28px; }
.inline { display: inline; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--border); font-weight: normal; }
th[scope=row] { color: var(--muted); }
pre.card { white-space: pre-wrap; }
`;

function layout({ title, settings = {}, body }) {
  const logo = settings.parishLogoUrl
    ? `<img src="${esc(settings.parishLogoUrl)}" alt="${esc(settings.parishName)}">`
    : '';
  return `<!doctype html>
<html lang="fi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header class="top">${logo}<strong>${esc(settings.parishName)}</strong></header>
<main>${body}</main>
</body>
</html>`;
}

export function errorPage(message) {
  return layout({ title: 'Virhe', body: `<h1>Virhe</h1><p class="notice">${esc(message)}</p>` });
}

export function publicPage({ event, settings, open, saved = false, errors = [], values = {} }) {
  const embed =
    event.source === 'youtube'
      ? `<div class="video"><iframe src="https://www.youtube-nocookie.com/embed/${esc(event.id)}" title="${esc(event.title)}" allow="encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe></div>`
      : event.url
        ? `<p><a href="${esc(event.url)}" rel="noopener">Avaa tilaisuus</a></p>`
        : '';
  const savedNotice = saved ? '<p class="notice ok" role="status">Kiitos! Tiedot on tallennettu.</p>' : '';
  const errorList = errors.length
    ? `<ul class="errors">${errors.map((error) => `<li>${esc(error)}</li>`).join('')}</ul>`
    : '';
  const form = open
    ? `<form method="post" class="stack">
${errorList}
<label>Ryhmän tai osallistujan nimi tai nimimerkki *
  <input name="groupName" required maxlength="100" value="${esc(values.groupName)}"></label>
<label>Katsojien määrä tilassa *
  <input name="watchers" type="number" required min="1" max="10000" inputmode="numeric" value="${esc(values.watchers)}"></label>
<label>Yhteystieto sähköpostina (valinnainen)
  <input name="contactEmail" type="email" maxlength="200" value="${esc(values.contactEmail)}"></label>
<p class="privacy">Tallennamme ryhmän nimen ja katsojamäärän vain tilaston laskemiseksi. Yhteystieto on vapaaehtoinen: sitä käytetään vain tilastoon liittyvään yhteydenottoon, jotta tilastosta vastaava voi tarvittaessa ottaa yhteyttä ennen tallenteen kirjaamista. Lomaketiedot yhteystietoineen poistetaan viikon kuluttua raportin lähettämisestä. Emme tallenna IP-osoitteita tai muita henkilötietoja.</p>
<div><button type="submit">Lähetä</button></div>
</form>`
    : '<p class="notice">Tämän tilaisuuden tilastointi on päättynyt. Kiitos osallistumisesta!</p>';
  return layout({
    title: event.title,
    settings,
    body: `<h1>${esc(event.title)}</h1>${embed}${savedNotice}${form}`,
  });
}

function labelsOf(map) {
  return Object.fromEntries(
    Object.entries(map).map(([key, value]) => [key, typeof value === 'string' ? value : value.label]),
  );
}

function options(map, selected) {
  return Object.entries(labelsOf(map))
    .map(([key, label]) => `<option value="${esc(key)}"${key === selected ? ' selected' : ''}>${esc(label)}</option>`)
    .join('');
}

const LIVE_LABELS = { live: 'live', upcoming: 'tulossa', none: 'julkaistu' };

function eventCard(event, now, settings) {
  const id = encodeURIComponent(event.id);
  const estimate = estimateParticipants(event, settings).total;
  const sent = event.reportSentAt
    ? `<p class="meta">Raportti lähetetty ${esc(formatDateTime(event.reportSentAt))}</p>`
    : '';
  return `<article class="card">
<h3>${esc(event.title)}<span class="badge">${esc(eventStatus(event, now))}</span></h3>
<p class="meta">${event.source === 'youtube' ? 'YouTube' : 'Manuaalinen linkki'} · ${esc(EVENT_TYPES[event.eventType].label)} · lomakkeita ${event.submissions.length} · osallistujat: ${esc(estimate ?? 'ei arvioitavissa')}</p>
<p><a href="/e/${id}">Julkinen linkki</a> · <a href="/admin/events/${id}">Tiedot</a></p>
${sent}
<form method="post" action="/admin/events/${id}" class="stack">
<div class="grid">
<label>Nimi <input name="title" required maxlength="200" value="${esc(event.title)}"></label>
<label>Tyyppi <select name="eventType">${options(EVENT_TYPES, event.eventType)}</select></label>
<label>Laskentatapa <select name="countingScheme"><option value="">Oletus: ${esc(COUNTING_SCHEMES[settings.liveModel])}</option>${options(COUNTING_SCHEMES, event.countingScheme ?? '')}</select></label>
<label>Tallennusaika (vrk, tyhjä = oletus ${EVENT_TYPES[event.eventType].vodDays}) <input type="number" name="vodDays" min="0" max="${MAX_VOD_DAYS}" value="${esc(event.vodDays ?? '')}"></label>
<label>Päättyi (Suomen aika) <input type="datetime-local" name="endsAt" value="${toLocalInput(event.endsAt)}"></label>
</div>
<label class="check"><input type="checkbox" name="enabled"${event.enabled ? ' checked' : ''}> Seurataan ja lomake käytössä</label>
<div class="actions">
<button name="action" value="save">Tallenna</button>
<button name="action" value="close" class="secondary">Sulje nyt</button>
${event.reportSentAt ? '<button name="action" value="resend" class="secondary">Lähetä raportti uudelleen</button>' : '<button name="action" value="report" class="secondary">Lähetä raportti nyt</button>'}
</div>
</form>
</article>`;
}

function videoSection(videos, error, trackedIds) {
  if (error) return `<p class="notice">${esc(error)}</p>`;
  if (!videos.length) return '<p class="meta">Ei videoita.</p>';
  return `<ul class="stack">${videos
    .map((video) => {
      const action = trackedIds.has(video.id)
        ? '<span class="meta">seurannassa</span>'
        : `<form method="post" action="/admin/events/from-video" class="inline"><input type="hidden" name="videoId" value="${esc(video.id)}"><button class="secondary">Seuraa tilastoa</button></form>`;
      return `<li>${esc(video.title)} <span class="meta">(${esc(LIVE_LABELS[video.liveBroadcastContent] ?? video.liveBroadcastContent)})</span> ${action}</li>`;
    })
    .join('')}</ul>`;
}

function settingsForm(settings) {
  return `<form method="post" action="/admin/settings" class="stack">
<div class="grid">
<label>Seurakunnan nimi <input name="parishName" maxlength="100" value="${esc(settings.parishName)}"></label>
<label>Seurakunnan logon osoite (https) <input name="parishLogoUrl" maxlength="500" value="${esc(settings.parishLogoUrl)}"></label>
<label>Raportin vastaanottaja (sähköposti) <input type="email" name="reportRecipient" maxlength="200" value="${esc(settings.reportRecipient)}"></label>
<label>Lähettäjän nimi <input name="senderName" maxlength="100" value="${esc(settings.senderName)}"></label>
<label>Lähettäjän sähköposti (vahvistettu Brevossa) <input type="email" name="senderEmail" maxlength="200" value="${esc(settings.senderEmail)}"></label>
</div>
<label>Oletuslaskentatapa (live) <select name="liveModel">${options(COUNTING_SCHEMES, settings.liveModel)}</select></label>
<label>Sähköpostin aihe <input name="emailSubject" required maxlength="300" value="${esc(settings.emailSubject)}"></label>
<label>Sähköpostin runko <textarea name="emailBody" required maxlength="10000">${esc(settings.emailBody)}</textarea></label>
<p class="meta">Käytettävät tagit: ${TEMPLATE_KEYS.map((key) => `[${esc(key)}]`).join(' ')}</p>
<div><button>Tallenna asetukset</button></div>
</form>`;
}

export function adminPage({ events, settings, videos, videosError, flash = '', now }) {
  const tracked = new Set(events.map((event) => event.id));
  const body = `<h1>Ylläpito</h1>
<p><a href="/admin/credentials">Tunnukset (YouTube, OAuth, Brevo)</a></p>
${flash ? `<p class="notice ok" role="status">${esc(flash)}</p>` : ''}
<section>
<h2>Uusi manuaalinen linkki</h2>
<form method="post" action="/admin/events/manual" class="grid">
<label>Nimi <input name="title" required maxlength="200"></label>
<label>Osoite (https://…) <input name="url" type="url" required maxlength="500"></label>
<label>Tyyppi <select name="eventType">${options(EVENT_TYPES, 'other')}</select></label>
<label>Päättyy (Suomen aika) <input type="datetime-local" name="endsAt" required></label>
<div class="actions"><button>Luo linkki</button></div>
</form>
</section>
<section>
<h2>Viimeisimmät videot seurakunnan kanavilta</h2>
${videoSection(videos, videosError, tracked)}
</section>
<section>
<h2>Tilaisuudet (${events.length})</h2>
${events.map((event) => eventCard(event, now, settings)).join('') || '<p class="meta">Ei tilaisuuksia.</p>'}
</section>
<section>
<h2>Asetukset ja raporttisähköposti</h2>
${settingsForm(settings)}
</section>`;
  return layout({ title: 'Ylläpito', settings, body });
}

function sourceLabel(item) {
  if (item.source === 'ui') return `Tallennettu täällä ${item.savedAt ? formatDateTime(item.savedAt) : ''}`.trim();
  if (item.source === 'env') return 'Ympäristömuuttujasta (palvelimen asetus)';
  return 'Ei asetettu';
}

function credentialCard({ title, help, item, action, fields, canStore, extra = '' }) {
  const state = item.configured
    ? `<span class="badge">${esc(sourceLabel(item))}${item.hint ? ` · ${esc(item.hint)}` : ''}</span>`
    : '<span class="badge">Ei asetettu</span>';
  const inputs = fields
    .map(
      (f) =>
        `<label>${esc(f.label)} <input name="${f.name}" type="${f.secret ? 'password' : 'text'}" autocomplete="off" maxlength="300"${f.value ? ` value="${esc(f.value)}"` : ''}${item.configured && f.secret ? ' placeholder="Jätä tyhjäksi, jos et vaihda"' : ''}${item.configured || f.optional ? '' : ' required'}></label>`,
    )
    .join('');
  const form = canStore
    ? `<form method="post" action="/admin/credentials/${action}" class="stack">
${inputs}
<label>Muistiinpano <input name="note" maxlength="500" value="${esc(item.note)}" placeholder="Esim. kenen tunnuksilla ja milloin luotu"></label>
<div class="actions"><button>Tallenna</button></div>
</form>
${item.source === 'ui' ? `<form method="post" action="/admin/credentials/${action}/delete"><button class="secondary">Poista tallennettu tunnus</button></form>` : ''}`
    : '<p class="meta">Tallennus on pois käytöstä (SECRETS_KEY puuttuu).</p>';
  return `<div class="card"><h3>${esc(title)} ${state}</h3><p class="meta">${esc(help)}</p>${extra}${form}</div>`;
}

export function credentialsPage({ status, canStore, redirectUri, channelIds = [], flash = '', settings }) {
  if (!status) return errorPage('Tunnusten hallinta ei ole käytössä.');
  const token = status.oauthToken;
  const identity = token.meta ?? {};
  const mismatch =
    identity.channelId && channelIds.length && !channelIds.includes(identity.channelId)
      ? `<p class="notice">Kirjautuneen kanavan tunnus ${esc(identity.channelId)} ei ole seurattavien kanavien listalla (YOUTUBE_CHANNEL_IDS). Analytics-haku ei toimi niiden kanavien videoille.</p>`
      : '';
  const who = token.configured
    ? token.source === 'ui'
      ? `<p>Kirjautunut: <strong>${esc(identity.channelTitle ?? 'kanava ei tiedossa')}</strong>${identity.email ? ` (${esc(identity.email)})` : ''}${identity.channelId ? `<br><span class="meta">Kanavan tunnus ${esc(identity.channelId)}</span>` : ''}</p>${mismatch}`
      : '<p class="meta">Pysyvä tunnus tulee ympäristömuuttujasta; kirjautunutta tiliä ei voi näyttää ennen uutta kirjautumista tässä.</p>'
    : '';
  const signIn =
    status.oauthClient.configured && canStore
      ? `<p><a href="/admin/oauth/start"><button type="button" class="secondary">${token.configured ? 'Kirjaudu uudelleen Googleen' : 'Kirjaudu Googleen'}</button></a></p>`
      : '<p class="meta">Tallenna ensin OAuth-asiakkaan tunnus ja salaisuus.</p>';
  const tokenNote =
    token.source === 'ui' && canStore
      ? `<form method="post" action="/admin/credentials/oauth-token" class="stack"><label>Muistiinpano <input name="note" maxlength="500" value="${esc(token.note)}"></label><div class="actions"><button class="secondary">Tallenna muistiinpano</button></div></form><form method="post" action="/admin/credentials/oauth-token/delete"><button class="secondary">Poista kirjautuminen</button></form>`
      : '';
  const body = `<h1>Tunnukset</h1>
<p><a href="/admin">← Ylläpitoon</a></p>
${flash ? `<p class="notice ok" role="status">${esc(flash)}</p>` : ''}
<p class="notice">${canStore ? 'Tunnukset tallennetaan salattuna (AES-256-GCM). Avain tulee palvelimen SECRETS_KEY-asetuksesta, eikä sitä tallenneta mihinkään. Tallennettu arvo ei näy enää tallennuksen jälkeen, vain sen loppu.' : 'Tallennus on pois käytöstä: aseta palvelimelle SECRETS_KEY (pitkä satunnainen merkkijono) ja käynnistä palvelu uudelleen. Siihen asti tunnukset luetaan ympäristömuuttujista.'} Täällä tallennettu tunnus voittaa ympäristömuuttujan.</p>
<section>
<h2>YouTube Data API</h2>
${credentialCard({ title: 'API-avain', help: 'Videoiden ja suorien lähetysten seuranta.', item: status.youtubeApiKey, action: 'youtube-key', fields: [{ name: 'apiKey', label: 'API-avain', secret: true }], canStore })}
</section>
<section>
<h2>YouTube Analytics (OAuth)</h2>
${credentialCard({ title: 'OAuth-asiakas', help: `Luo Google Cloudissa OAuth-asiakas (verkkosovellus) ja lisää sallituksi uudelleenohjausosoitteeksi: ${redirectUri}`, item: status.oauthClient, action: 'oauth-client', fields: [{ name: 'clientId', label: 'Asiakastunnus', value: status.oauthClient.clientId }, { name: 'clientSecret', label: 'Asiakkaan salaisuus', secret: true }], canStore })}
<div class="card"><h3>Kirjautuminen ${token.configured ? `<span class="badge">${esc(sourceLabel(token))}</span>` : '<span class="badge">Ei kirjautunut</span>'}</h3>
<p class="meta">Kirjaudu kanavan omistajan tai ylläpitäjän Google-tilillä. Oikeudet: Analytics-lukuoikeus sekä kanavan ja sähköpostiosoitteen näyttäminen tällä sivulla.</p>
${who}${signIn}${tokenNote}</div>
</section>
<section>
<h2>Sähköposti</h2>
${credentialCard({ title: 'Brevo-API-avain', help: 'Raporttien lähetys.', item: status.brevoApiKey, action: 'brevo', fields: [{ name: 'apiKey', label: 'API-avain', secret: true }], canStore })}
</section>`;
  return layout({ title: 'Tunnukset', settings, body });
}

const orDash = (value) => (value === null || value === undefined ? 'ei saatavilla' : value);

function row(label, value) {
  return `<tr><th scope="row">${esc(label)}</th><td>${esc(orDash(value))}</td></tr>`;
}

export function eventDetailsPage({ event, settings, report, flash = '', now }) {
  const id = encodeURIComponent(event.id);
  const sent = Boolean(event.reportSentAt);
  // After the report the figures are frozen in the snapshot; before it they are computed from the live data.
  const est = event.reportSnapshot ?? estimateParticipants(event, settings);
  const purgeAt = formsPurgeAt(event);
  const due = reportAt(event);
  const forms = event.submissions.length
    ? `<table><thead><tr><th>Ilmoitettu</th><th>Ryhmä</th><th>Katsojia</th><th>Yhteystieto</th></tr></thead><tbody>${event.submissions
        .map(
          (submission) =>
            `<tr><td>${esc(formatDateTime(submission.createdAt))}</td><td>${esc(submission.groupName)}</td><td>${esc(submission.watchers)}</td><td>${esc(submission.contactEmail ?? '')}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : event.formsPurgedAt
      ? `<p class="meta">Lomakkeet poistettiin ${esc(formatDateTime(event.formsPurgedAt))}. Raportoidut luvut ovat tallessa.</p>`
      : '<p class="meta">Ei lomakkeita.</p>';
  const body = `<h1>${esc(event.title)}<span class="badge">${esc(eventStatus(event, now))}</span></h1>
<p><a href="/admin">← Ylläpitoon</a> · <a href="/e/${id}">Julkinen sivu</a>${event.url ? ` · <a href="${esc(event.url)}" rel="noopener">Tilaisuus</a>` : ''}</p>
${flash ? `<p class="notice ok" role="status">${esc(flash)}</p>` : ''}
<form method="post" action="/admin/events/${id}" class="actions">
<input type="hidden" name="next" value="/admin/events/${id}">
${sent ? '<button name="action" value="resend">Lähetä raportti uudelleen</button>' : '<button name="action" value="report">Lähetä raportti nyt</button>'}
<button name="action" value="close" class="secondary">Sulje lomake nyt</button>
</form>
${sent ? `<p class="meta">Raportti lähetettiin ${esc(formatDateTime(event.reportSentAt))}${event.reportResentAt ? `, uudelleen ${esc(formatDateTime(event.reportResentAt))}` : ''}.</p>` : '<p class="meta">Raportti lähtee muuten automaattisesti, kun tallennusaika on päättynyt.</p>'}
<section>
<h2>Osallistujat${sent ? ' (raportoitu)' : ' (arvio nyt)'}</h2>
<table><tbody>
${row(`Live-katsojat (${COUNTING_SCHEMES[est.model]})`, est.live)}
${row('Lomakkeita (ryhmiä)', est.groups)}
${row('Ryhmien katsojat yhteensä', est.watchers)}
${row('Live ryhmien jälkeen (−1 per ryhmä)', est.liveAfterGroups)}
${row(`Tallenteen katselut (${vodDaysOf(event)} vrk)`, est.vod)}
${row('Osallistujat yhteensä', est.total)}
</tbody></table>
</section>
<section>
<h2>Lomakkeet (${event.submissions.length})</h2>
${forms}
${purgeAt && !event.formsPurgedAt ? `<p class="meta">Lomakkeet poistetaan ${esc(formatDateTime(purgeAt))} (${FORM_RETENTION_DAYS} vrk raportista).</p>` : ''}
</section>
<section>
<h2>YouTube-luvut</h2>
<table><tbody>
${row('Samanaikaisten katsojien enimmäismäärä (Analytics)', event.analytics?.peakConcurrentViewers)}
${row('Samanaikaisten katsojien keskiarvo (Analytics)', event.analytics?.averageConcurrentViewers)}
${row('Katselukerrat nyt (viimeisin haku)', event.youtube?.viewCount)}
${row('Katselukerrat lähetyksen päättyessä', event.viewCountAtEnd)}
${row('Analytics haettu', event.analytics?.fetchedAt ? formatDateTime(event.analytics.fetchedAt) : null)}
${row('YouTube-tila viimeksi tarkistettu', event.youtube?.checkedAt ? formatDateTime(event.youtube.checkedAt) : null)}
</tbody></table>
</section>
<section>
<h2>Ajat ja asetukset</h2>
<table><tbody>
${row('Tyyppi', EVENT_TYPES[event.eventType].label)}
${row('Alkoi', event.startsAt ? formatDateTime(event.startsAt) : null)}
${row('Päättyi', event.endsAt ? formatDateTime(event.endsAt) : null)}
${row('Lomake sulkeutuu', event.closedAt ? formatDateTime(event.closedAt) : null)}
${row('Tallennusaika', `${vodDaysOf(event)} vrk`)}
${row('Raportti erääntyy', due ? formatDateTime(due) : null)}
${row('Raportti lähetetty', event.reportSentAt ? formatDateTime(event.reportSentAt) : null)}
${row('Raportti lähetetty uudelleen', event.reportResentAt ? formatDateTime(event.reportResentAt) : null)}
${row('Live-laskentatapa', COUNTING_SCHEMES[liveModelOf(event, settings)])}
</tbody></table>
</section>
${
  sent
    ? ''
    : `<section><h2>Raportin esikatselu</h2><p class="meta">Aihe: ${esc(report.subject)}</p><pre class="card">${esc(report.text)}</pre></section>`
}`;
  return layout({ title: event.title, settings, body });
}
