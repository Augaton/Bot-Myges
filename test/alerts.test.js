const test = require('node:test');
const assert = require('node:assert');
const { dist } = require('./helpers');

const { gradeEvents, upcomingDeadlines, dueReminders } = dist('tasks/personalAlerts.js');

const H = 3_600_000;

test('notes : contrôle continu, examen et moyenne deviennent des évènements distincts', () => {
    const events = gradeEvents([
        { course: 'T1 - Anglais', trimester_name: 'Trimestre 1', grades: [15, 12.5], exam: 14, average: 13.8 },
        { course: 'Réseau', trimester_name: 'Trimestre 1', grades: [], exam: 0, average: null },
    ]);
    assert.deepStrictEqual(events.map((e) => e.id), [
        'Trimestre 1|Anglais|cc|0|15',
        'Trimestre 1|Anglais|cc|1|12.5',
        'Trimestre 1|Anglais|exam|14',
        'Trimestre 1|Anglais|average|13.8',
    ]); // examen à 0 = pas encore noté : ignoré
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
