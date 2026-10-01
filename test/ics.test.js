const test = require('node:test');
const assert = require('node:assert');
const { dist } = require('./helpers');

const { buildIcs, escapeText, foldLine } = dist('utils/ics.js');

test('échappement des caractères spéciaux iCalendar', () => {
    assert.strictEqual(escapeText('a;b,c\\d\ne'), 'a\;b\\,c\\\\d\\ne');
});

test('repli des lignes à 75 octets sans couper un accent', () => {
    const line = `SUMMARY:${'é'.repeat(100)}`;
    const folded = foldLine(line);
    for (const part of folded.split('\r\n')) assert.ok(Buffer.byteLength(part) <= 75, part);
    assert.strictEqual(folded.split('\r\n').map((p, i) => (i ? p.slice(1) : p)).join(''), line);
});

test('un cours devient un VEVENT en UTC, avec salle et campus', () => {
    const ics = buildIcs([{
        reservation_id: 42,
        name: 'T1 - Programmation, avancée',
        start_date: Date.parse('2026-09-28T09:00:00+02:00'),
        end_date: Date.parse('2026-09-28T12:00:00+02:00'),
        rooms: [{ name: 'Salle 12', campus: 'NATION1' }],
        teacher: 'M. Dupont',
        modality: 'Présentiel',
    }], new Date('2026-10-01T10:00:00Z'));

    assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
    assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
    assert.match(ics, /UID:myges-42@botmyges/);
    assert.match(ics, /DTSTART:20260928T070000Z/); // 9 h à Paris = 7 h UTC
    assert.match(ics, /DTEND:20260928T100000Z/);
    assert.match(ics, /SUMMARY:Programmation\\, avancée/);
    assert.match(ics, /LOCATION:Salle 12 \(Nation 1\)/);
    assert.ok(!/\r\n\r\n/.test(ics) && !/[^\r]\n/.test(ics), 'fins de ligne CRLF uniquement');
});

test('les cours en double ou sans date valide sont ignorés', () => {
    const c = { reservation_id: 1, name: 'A', start_date: 0, end_date: 3600_000 };
    const ics = buildIcs([c, c, { name: 'B', start_date: 'x', end_date: 'y' }]);
    assert.strictEqual(ics.match(/BEGIN:VEVENT/g).length, 1);
});
