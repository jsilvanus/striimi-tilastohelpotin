import {
  COUNTING_SCHEMES,
  EVENT_TYPES,
  TEMPLATE_KEYS,
  countParticipants,
  eventStatus,
  formatDateTime,
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
<p class="privacy">Tallennamme ryhmän nimen ja katsojamäärän vain tilaston laskemiseksi. Yhteystieto on vapaaehtoinen: sitä käytetään vain tilastoon liittyvään yhteydenottoon, ja se poistetaan raportin lähettämisen jälkeen. Emme tallenna IP-osoitteita tai muita henkilötietoja.</p>
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

function eventCard(event, now) {
  const id = encodeURIComponent(event.id);
  const count = countParticipants(event);
  const sent = event.reportSentAt
    ? `<p class="meta">Raportti lähetetty ${esc(formatDateTime(event.reportSentAt))}</p>`
    : '';
  return `<article class="card">
<h3>${esc(event.title)}<span class="badge">${esc(eventStatus(event, now))}</span></h3>
<p class="meta">${event.source === 'youtube' ? 'YouTube' : 'Manuaalinen linkki'} · ${esc(EVENT_TYPES[event.eventType].label)} · lomakkeita ${event.submissions.length} · osallistujat: ${esc(count ?? 'ei arvioitavissa')}</p>
<p><a href="/e/${id}">Julkinen linkki</a></p>
${sent}
<form method="post" action="/admin/events/${id}" class="stack">
<div class="grid">
<label>Nimi <input name="title" required maxlength="200" value="${esc(event.title)}"></label>
<label>Tyyppi <select name="eventType">${options(EVENT_TYPES, event.eventType)}</select></label>
<label>Laskentatapa <select name="countingScheme">${options(COUNTING_SCHEMES, event.countingScheme)}</select></label>
<label>Päättyi (Suomen aika) <input type="datetime-local" name="endsAt" value="${toLocalInput(event.endsAt)}"></label>
</div>
<label class="check"><input type="checkbox" name="enabled"${event.enabled ? ' checked' : ''}> Seurataan ja lomake käytössä</label>
<div class="actions">
<button name="action" value="save">Tallenna</button>
<button name="action" value="close" class="secondary">Sulje nyt</button>
<button name="action" value="report" class="secondary"${event.reportSentAt ? ' disabled' : ''}>Lähetä raportti nyt</button>
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
<label>Sähköpostin aihe <input name="emailSubject" required maxlength="300" value="${esc(settings.emailSubject)}"></label>
<label>Sähköpostin runko <textarea name="emailBody" required maxlength="10000">${esc(settings.emailBody)}</textarea></label>
<p class="meta">Käytettävät tagit: ${TEMPLATE_KEYS.map((key) => `[${esc(key)}]`).join(' ')}</p>
<div><button>Tallenna asetukset</button></div>
</form>`;
}

export function adminPage({ events, settings, videos, videosError, flash = '', now }) {
  const tracked = new Set(events.map((event) => event.id));
  const body = `<h1>Ylläpito</h1>
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
${events.map((event) => eventCard(event, now)).join('') || '<p class="meta">Ei tilaisuuksia.</p>'}
</section>
<section>
<h2>Asetukset ja raporttisähköposti</h2>
${settingsForm(settings)}
</section>`;
  return layout({ title: 'Ylläpito', settings, body });
}
