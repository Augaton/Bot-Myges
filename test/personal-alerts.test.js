// Cycle complet des alertes en MP, avec MyGes simulé et un faux client Discord.
const test = require('node:test');
const assert = require('node:assert');
const { dist, mockFetch, json, redirect } = require('./helpers');

const store = dist('core/store.js');
const { encrypt } = dist('crypto.js');
const { runPersonalCheck } = dist('tasks/personalAlerts.js');

const H = 3_600_000;
const dms = [];
const client = { users: { fetch: async (id) => ({ send: async (payload) => dms.push({ id, payload }) }) } };
const titles = () => dms.flatMap((d) => d.payload.embeds.map((e) => e.data.title));

test('notes mémorisées sans MP au premier passage, puis MP à chaque nouvelle note ; rappel la veille', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-01T10:00:00Z') });
    const now = Date.now();

    const data = store.loadData();
    data.users.u1 = { user: encrypt('p.nom'), pass: encrypt('secret') };
    store.saveData(data);

    const grades = [{ course: 'Anglais', trimester_name: 'Trimestre 1', grades: [15] }];
    const projects = [{ project_id: 7, name: 'Projet Web', course_name: 'Web', steps: [{ psp_id: 1, psp_limit_date: now + 20 * H, psp_type: 'Rendu' }] }];

    // Passage 1 : connexion, notes (mémorisées), projets (rendu dans 20 h → rappel « demain »).
    mockFetch([
        redirect('x:/#access_token=t1&token_type=bearer&expires_in=86400'),
        json(200, { result: grades }),
        json(200, { result: projects }),
    ]);
    await runPersonalCheck(client);
    assert.deepStrictEqual(titles(), ['📅 Rendu demain']);

    // Passage 2, une heure plus tard : une nouvelle note est apparue.
    t.mock.timers.tick(61 * 60_000);
    mockFetch([
        json(200, { result: [{ ...grades[0], grades: [15, 17.5] }] }),
        json(200, { result: projects }),
    ]);
    await runPersonalCheck(client);
    assert.deepStrictEqual(titles(), ['📅 Rendu demain', '📝 Nouvelle note !']);
    assert.match(dms[1].payload.embeds[0].data.fields[0].value, /Note : \*\*17,5\*\*\/20/);

    // Les notes ne sont jamais enregistrées en clair.
    assert.ok(!JSON.stringify(store.loadData().alerts).includes('Anglais'));
});

test('alertes désactivées : aucun appel à MyGes, aucun MP', async (t) => {
    // Une demi-heure après le passage précédent : u1 n'a encore rien à relire.
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-01T11:30:00Z') });
    const data = store.loadData();
    data.users.u2 = { user: encrypt('p.autre'), pass: encrypt('secret') };
    store.getUserAlerts(data, 'u2').grades = false;
    store.getUserAlerts(data, 'u2').reminders = false;
    store.saveData(data);
    const before = dms.length;
    const calls = mockFetch([]);
    await runPersonalCheck(client);
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(dms.length, before);
});
