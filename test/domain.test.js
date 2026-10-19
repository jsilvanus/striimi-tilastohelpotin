import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  buildReport,
  countParticipants,
  createEvent,
  fromLocalInput,
  isFormOpen,
  renderTemplate,
  reportAt,
  toLocalInput,
} from '../src/domain.js';

const base = { id: 'abc12345678', source: 'youtube', title: 'Jumalanpalvelus', eventType: 'worship' };

test('max_concurrent uses the highest sampled viewer count', () => {
  const event = createEvent({ ...base, countingScheme: 'max_concurrent', samples: [{ viewers: 10 }, { viewers: 42 }, { viewers: 30 }] });
  assert.equal(countParticipants(event), 42);
});

test('average_concurrent rounds the mean of the samples', () => {
  const event = createEvent({ ...base, countingScheme: 'average_concurrent', samples: [{ viewers: 10 }, { viewers: 15 }] });
  assert.equal(countParticipants(event), 13);
});

test('views uses the YouTube view count and is null without one', () => {
  assert.equal(countParticipants(createEvent({ ...base, countingScheme: 'views', youtube: { viewCount: 120 } })), 120);
  assert.equal(countParticipants(createEvent({ ...base, countingScheme: 'views' })), null);
});

test('schemes without samples are not estimable', () => {
  assert.equal(countParticipants(createEvent({ ...base, countingScheme: 'max_concurrent' })), null);
  assert.equal(countParticipants(createEvent({ ...base, countingScheme: 'average_concurrent' })), null);
});

test('form stays open for the grace period after the event has ended', () => {
  const event = createEvent({ ...base, endsAt: '2026-10-18T12:00:00.000Z' });
  assert.equal(isFormOpen(event, new Date('2026-10-18T12:20:00.000Z')), true);
  assert.equal(isFormOpen(event, new Date('2026-10-18T12:31:00.000Z')), false);
});

test('form is open while the end time is unknown and closed when disabled', () => {
  assert.equal(isFormOpen(createEvent({ ...base }), new Date()), true);
  assert.equal(isFormOpen(createEvent({ ...base, enabled: false }), new Date()), false);
});

test('worship services are reported 48 hours after they end', () => {
  const event = createEvent({ ...base, endsAt: '2026-10-18T12:00:00.000Z' });
  assert.equal(reportAt(event).toISOString(), '2026-10-20T12:00:00.000Z');
});

test('ceremonies are reported right after they end', () => {
  const event = createEvent({ ...base, eventType: 'ceremony', endsAt: '2026-10-18T12:00:00.000Z' });
  assert.equal(reportAt(event).toISOString(), '2026-10-18T12:00:00.000Z');
});

test('renderTemplate replaces known tags in a single pass and leaves others alone', () => {
  const out = renderTemplate('[EVENT NAME] [SUMMARY] [UNKNOWN]', { 'EVENT NAME': '[SUMMARY]', SUMMARY: 'x' });
  assert.equal(out, '[SUMMARY] x [UNKNOWN]');
});

test('buildReport fills the tags and leaves contact emails out of the email', () => {
  const event = createEvent({
    ...base,
    endsAt: '2026-10-18T12:00:00.000Z',
    samples: [{ viewers: 25 }],
    youtube: { viewCount: 300 },
    submissions: [
      { groupName: 'Nuorten ryhmä', watchers: 12, contactEmail: 'secret@example.com' },
      { groupName: 'Vanhainkoti', watchers: 8, contactEmail: null },
    ],
  });
  const settings = { ...DEFAULT_SETTINGS, reportRecipient: 'tilasto@example.com', senderEmail: 'a@example.com' };
  const { subject, text } = buildReport(event, settings, 'https://striimi.example.fi');

  assert.equal(subject, 'Tilastoi striimin osallistujat: Jumalanpalvelus');
  assert.match(text, /https:\/\/striimi\.example\.fi\/e\/abc12345678/);
  assert.match(text, /- Nuorten ryhmä: 12\n- Vanhainkoti: 8/);
  assert.match(text, /Samanaikaisia katsojia \(enimmäismäärä\): 25/);
  assert.match(text, /Katselukerrat yhteensä: 300/);
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
