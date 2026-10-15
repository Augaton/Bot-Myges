const test = require('node:test');
const assert = require('node:assert');
const { dist } = require('./helpers');

const { gradeEvents, upcomingDeadlines, dueReminders, agendaChanges } = dist('tasks/personalAlerts.js');

const H = 3_600_000;

test('notes : contrôle continu, examen et moyenne deviennent des évènements distincts', () => {
    const events = gradeEvents([
        { course: 'T1 - Anglais', trimester_name: 'Trimestre 1', grades: [15, 12.5], exam: 14, average: 13.8 },
        { course: 'Réseau', trimester_name: 'Trimestre 1', grades: [], exam: 0, average: null },
    ]);
    assert.deepStrictEqual(events.map((e) => e.id), [
        'Trimestre 1|Anglais|cc|15|1',
        'Trimestre 1|Anglais|cc|12.5|1',
        'Trimestre 1|Anglais|exam|14',
        'Trimestre 1|Anglais|average|13.8',
    ]); // examen à 0 = pas encore noté : ignoré
});

test('notes : retirer ou insérer une note ne fait pas passer les autres pour nouvelles', () => {
    const ids = (grades) => new Set(gradeEvents([{ course: 'Web', trimester_name: 'T1', grades }]).map((e) => e.id));
    const before = ids([12, 15, 12]);
    assert.strictEqual(before.size, 3); // deux 12 : deux notes distinctes

    const afterRemoval = ids([15, 12]);
    assert.ok([...afterRemoval].every((id) => before.has(id)));

    const fresh = [...ids([12, 9, 15, 12])].filter((id) => !before.has(id));
    assert.deepStrictEqual(fresh, ['T1|Web|cc|9|1']);
});

test('échéances : étapes futures uniquement, fin de projet à défaut d\'étapes', () => {
    const now = Date.now();
    const deadlines = upcomingDeadlines([
        { project_id: 1, name: 'P1', course_name: 'Web', steps: [
            { psp_id: 10, psp_limit_date: now - H, psp_type: 'Passée' },
            { psp_id: 11, psp_limit_date: now + 5 * H, psp_type: 'Rendu', psp_desc: '<b>Dépôt</b> du code' },
        ] },
        { project_id: 2, name: 'P2', steps: [], end_date: now + 30 * H },
    ], now);
    assert.deepStrictEqual(deadlines.map((d) => d.key), ['1|11', '2|fin']);
    assert.strictEqual(deadlines[0].desc, 'Dépôt du code');
});

test('rappels : la veille, puis 2 h avant, jamais deux fois le même', () => {
    const now = Date.now();
    const d = (inHours) => [{ key: 'p|s', at: now + inHours * H, project: 'P', course: '', type: 'Rendu', desc: '' }];

    assert.strictEqual(dueReminders(d(30), now, {}).length, 0); // trop tôt
    const veille = dueReminders(d(20), now, {});
    assert.strictEqual(veille[0].threshold.ms, 24 * H);
    assert.strictEqual(dueReminders(d(20), now, { [veille[0].id]: 1 }).length, 0); // déjà envoyé

    // À 1 h 30 : seul le rappel « 2 h » part, même si celui de la veille a été manqué.
    const proche = dueReminders(d(1.5), now, {});
    assert.strictEqual(proche.length, 1);
    assert.strictEqual(proche[0].threshold.ms, 2 * H);
});

// Agenda : cours fictifs à `h` heures de T0.
const T0 = Date.parse('2026-10-05T08:00:00Z');
const course = (id, h, extra = {}) => ({
    reservation_id: id,
    name: 'T1 - Anglais',
    start_date: T0 + h * H,
    end_date: T0 + (h + 2) * H,
    rooms: [{ name: 'Salle 12', campus: 'NATION1' }],
    ...extra,
});

test('agenda : premier passage silencieux, puis annulé, ajouté, déplacé, changement de salle', () => {
    const first = agendaChanges([course(1, 24), course(2, 48), course(3, 72), course(4, 30, { rooms: [] })], null, T0, T0 + 7 * 24 * H);
    assert.deepStrictEqual(first.changes, []);
    assert.deepStrictEqual(Object.keys(first.next.courses), ['1', '2', '3', '4']);
    assert.strictEqual(first.next.courses[1].place, 'Salle 12 (Nation 1)');

    const { changes } = agendaChanges([
        // 1 : disparu
        course(2, 50),
        course(3, 72, { rooms: [{ name: 'Salle 7', campus: 'NATION1' }] }),
        course(4, 30, { rooms: [{ name: 'Salle 9' }] }), // salle attribuée après coup : rien à dire
        course(5, 40),
        course(6, 7.5 * 24), // entre dans la semaine au fil des jours : pas « nouveau »
    ], first.next, T0 + H, T0 + 8 * 24 * H);
    assert.deepStrictEqual(changes.map((c) => c.kind), ['cancelled', 'added', 'moved', 'room']);
    assert.strictEqual(changes[2].before.start, T0 + 48 * H);
    assert.strictEqual(changes[2].after.start, T0 + 50 * H);
    assert.strictEqual(changes[3].after.place, 'Salle 7 (Nation 1)');
});

test('agenda : une réponse vide de MyGes n\'annonce pas une semaine entière annulée', () => {
    const { next: snapshot } = agendaChanges([course(1, 24), course(2, 48)], null, T0, T0 + 7 * 24 * H);
    const result = agendaChanges([], snapshot, T0 + H, T0 + 8 * 24 * H);
    assert.deepStrictEqual(result.changes, []);
    assert.strictEqual(result.next, snapshot); // lecture précédente conservée
});
