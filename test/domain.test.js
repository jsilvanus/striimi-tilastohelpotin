import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  buildReport,
  createEvent,
  estimateParticipants,
  fromLocalInput,
  isFormOpen,
  liveValue,
  renderTemplate,
  reportAt,
  toLocalInput,
  vodViews,
} from '../src/domain.js';

const base = { id: 'abc12345678', source: 'youtube', title: 'Jumalanpalvelus', eventType: 'worship' };
const settings = { ...DEFAULT_SETTINGS, liveModel: 'average_concurrent' };
const submission = (groupName, watchers, contactEmail = null) => ({ id: groupName, groupName, watchers, contactEmail, createdAt: '2026-10-18T12:00:00Z' });

test('live value is the Analytics peak or average, and unknown without Analytics', () => {
  const event = createEvent({ ...base, analytics: { peakConcurrentViewers: 90, averageConcurrentViewers: 30 } });
  assert.equal(liveValue(event, 'max_concurrent'), 90);
  assert.equal(liveValue(event, 'average_concurrent'), 30);
  assert.equal(liveValue(createEvent({ ...base }), 'max_concurrent'), null);
});

test('each registered group replaces one live viewer, then group watchers and recording views are added', () => {
  const event = createEvent({
    ...base,
    endsAt: '2026-10-18T12:00:00.000Z',
    countingScheme: 'max_concurrent',
    analytics: { peakConcurrentViewers: 40, averageConcurrentViewers: 27 },
    youtube: { viewCount: 160 },
    viewCountAtEnd: 100,
    submissions: [submission('Nuoret', 12), submission('Vanhainkoti', 8)],
  });
  const est = estimateParticipants(event, settings);
  assert.equal(est.model, 'max_concurrent');
  assert.equal(est.live, 40);
  assert.equal(est.liveAfterGroups, 38);
  assert.equal(est.watchers, 20);
  assert.equal(est.vod, 60);
  assert.equal(est.total, 118);
});

test('the event model overrides the global default, and the global default applies otherwise', () => {
  const event = createEvent({ ...base, analytics: { peakConcurrentViewers: 40, averageConcurrentViewers: 25 } });
  assert.equal(estimateParticipants(event, settings).model, 'average_concurrent');
  assert.equal(estimateParticipants({ ...event, countingScheme: 'max_concurrent' }, settings).live, 40);
});

test('live viewers never go below zero when there are more groups than viewers', () => {
  const event = createEvent({
    ...base,
    analytics: { peakConcurrentViewers: 1, averageConcurrentViewers: 1 },
    submissions: [submission('A', 3), submission('B', 4)],
  });
  assert.equal(estimateParticipants(event, settings).liveAfterGroups, 0);
  assert.equal(estimateParticipants(event, settings).total, 7);
});

test('recording views are unknown until the end count is known, and zero for ceremonies', () => {
  const withoutEnd = createEvent({ ...base, youtube: { viewCount: 50 } });
  assert.equal(vodViews(withoutEnd), null);
  const ceremony = createEvent({ ...base, eventType: 'ceremony', youtube: { viewCount: 50 } });
  assert.equal(vodViews(ceremony), 0);
});

test('an event with nothing measured has no estimate', () => {
  assert.equal(estimateParticipants(createEvent({ ...base }), settings).total, null);
});

test('the storage window counts calendar days in Finnish time, ending at midnight', () => {
  const end = '2026-10-18T12:00:00.000Z';
  // Worship: the service day plus two more days, so Sunday runs through Tuesday.
  assert.equal(reportAt(createEvent({ ...base, endsAt: end })).toISOString(), '2026-10-20T21:00:00.000Z');
  assert.equal(reportAt(createEvent({ ...base, eventType: 'other', endsAt: end })).toISOString(), '2026-10-24T21:00:00.000Z');
  assert.equal(reportAt(createEvent({ ...base, eventType: 'other', vodDays: 21, endsAt: end })).toISOString(), '2026-11-07T22:00:00.000Z');
  assert.equal(reportAt(createEvent({ ...base, eventType: 'ceremony', endsAt: end })).toISOString(), end);
  assert.equal(reportAt(createEvent({ ...base })), null);
});

test('the form stays open for the grace period after the event has ended', () => {
  const event = createEvent({ ...base, endsAt: '2026-10-18T12:00:00.000Z' });
  assert.equal(isFormOpen(event, new Date('2026-10-18T12:20:00.000Z')), true);
  assert.equal(isFormOpen(event, new Date('2026-10-18T12:31:00.000Z')), false);
});

test('renderTemplate replaces known tags in a single pass and leaves others alone', () => {
  const out = renderTemplate('[EVENT NAME] [SUMMARY] [UNKNOWN]', { 'EVENT NAME': '[SUMMARY]', SUMMARY: 'x' });
  assert.equal(out, '[SUMMARY] x [UNKNOWN]');
});

test('buildReport lists the breakdown and leaves contact emails out of the email', () => {
  const event = createEvent({
    ...base,
    endsAt: '2026-10-18T12:00:00.000Z',
    analytics: { peakConcurrentViewers: 25, averageConcurrentViewers: 20 },
    youtube: { viewCount: 300 },
    viewCountAtEnd: 200,
    countingScheme: 'max_concurrent',
    submissions: [submission('Nuorten ryhmä', 12, 'secret@example.com'), submission('Vanhainkoti', 8)],
  });
  const { subject, text } = buildReport(event, { ...settings, reportRecipient: 'tilasto@example.com', senderEmail: 'a@example.com' }, 'https://striimi.example.fi');

  assert.equal(subject, 'Tilastoi striimin osallistujat: Jumalanpalvelus');
  assert.match(text, /https:\/\/striimi\.example\.fi\/e\/abc12345678/);
  assert.match(text, /- Nuorten ryhmä: 12\n- Vanhainkoti: 8/);
  assert.match(text, /Live-luku ryhmien jälkeen .*: 23/);
  assert.match(text, /Tallenteen katselut \(3 vrk päättymisestä\): 100/);
  assert.match(text, /Osallistujat yhteensä: 143/);
  assert.doesNotMatch(text, /secret@example\.com/);
  assert.doesNotMatch(text, /\[(EVENT NAME|SUMMARY|FILLED FORMS|YOUTUBE COUNTS)\]/);
});

test('local datetime input is read as Helsinki time', () => {
  assert.equal(fromLocalInput('2026-10-19T18:00'), '2026-10-19T15:00:00.000Z');
  assert.equal(fromLocalInput('2026-01-10T18:00'), '2026-01-10T16:00:00.000Z');
  assert.equal(toLocalInput('2026-10-19T15:00:00.000Z'), '2026-10-19T18:00');
  assert.equal(fromLocalInput(''), null);
  assert.equal(fromLocalInput('ei päivämäärä'), null);
});
