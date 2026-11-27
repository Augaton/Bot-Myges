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
const login = () => redirect('x:/#access_token=t1&token_type=bearer&expires_in=86400');

function register(userId, prefs = {}) {
    const data = store.loadData();
    data.users[userId] = { user: encrypt('p.nom'), pass: encrypt('secret') };
    Object.assign(store.getUserAlerts(data, userId), prefs);
    store.saveData(data);
}

test('notes, rappel la veille et changement d\'agenda : premier passage silencieux, puis MP', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-01T10:00:00Z') });
    const now = Date.now();
    register('u1');

    const grades = [{ course: 'Anglais', trimester_name: 'Trimestre 1', grades: [15] }];
    const projects = [{ project_id: 7, name: 'Projet Web', course_name: 'Web', steps: [{ psp_id: 1, psp_limit_date: now + 20 * H, psp_type: 'Rendu' }] }];
    const lesson = (startIn) => [{ reservation_id: 9, name: 'Anglais', start_date: now + startIn * H, end_date: now + (startIn + 2) * H, rooms: [] }];

    const absences = [{ course_name: 'Anglais', date: now - 48 * H, justified: true }];

    // Passage 1 : connexion, notes et absences (mémorisées), projets et TP (rendu
    // dans 20 h → rappel « demain »), agenda (mémorisé).
    const years = () => json(200, { result: [2026] }); // l'année en cours selon MyGes, lue une fois
    mockFetch([
        login(), years(), json(200, { result: grades }), json(200, { result: absences }), json(200, { result: projects }),
        new Response(null, { status: 204 }), json(200, { result: lesson(26) }),
    ]);
    await runPersonalCheck(client);
    assert.deepStrictEqual(titles(), ['📅 Rendu demain']);

    // Passage 2, une heure plus tard : une nouvelle note, et le cours a été déplacé.
    t.mock.timers.tick(61 * 60_000);
    mockFetch([ // la liste des années est encore en cache (3 h)
        json(200, { result: [{ ...grades[0], grades: [15, 17.5] }] }),
        json(200, { result: [...absences, { course_name: 'Réseaux', date: now - 2 * H, justified: false }] }),
        json(200, { result: projects }),
        json(200, { result: [{ project_id: 8, name: 'TP Linux', steps: [{ psp_id: 2, psp_limit_date: now + 22 * H, psp_type: 'Rendu' }] }] }),
        json(200, { result: lesson(50) }),
    ]);
    await runPersonalCheck(client);
    assert.deepStrictEqual(titles(), [
        '📅 Rendu demain', '📝 Nouvelle note !', '🚫 Nouvelle absence', '📅 Rendu demain', '🗓️ Changement dans ton agenda',
    ]);
    assert.match(dms[1].payload.embeds[0].data.fields[0].value, /Note : \*\*17,5\*\*\/20/);
    assert.match(dms[2].payload.embeds[0].data.description, /Réseaux.*non justifiée/);
    assert.doesNotMatch(dms[2].payload.embeds[0].data.description, /Anglais/); // déjà connue
    assert.match(dms[3].payload.embeds[0].data.description, /TP Linux/);
    assert.match(dms[4].payload.embeds[0].data.fields[0].name, /Cours déplacé · Anglais/);

    // Ni les notes, ni les absences, ni l'agenda ne sont enregistrés en clair.
    assert.ok(!/Anglais|Réseaux/.test(JSON.stringify(store.loadData().alerts)));
});

test('alertes désactivées : aucun appel à MyGes, aucun MP', async (t) => {
    // Une demi-heure après le passage précédent : u1 n'a encore rien à relire.
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-01T11:30:00Z') });
    register('u2', { grades: false, absences: false, reminders: false, agenda: false, digest: false });
    const before = dms.length;
    const calls = mockFetch([]);
    await runPersonalCheck(client);
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(dms.length, before);
});

test('programme du matin : à partir de 7 h, une seule fois par jour, cours du jour uniquement', async (t) => {
    // 6 h 50 à Paris (UTC+2 en octobre).
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-02T04:50:00Z') });
    register('u1', { grades: false, absences: false, reminders: false, agenda: false });
    register('u3', { grades: false, absences: false, reminders: false, agenda: false, digest: true });

    let calls = mockFetch([]);
    await runPersonalCheck(client);
    assert.strictEqual(calls.length, 0); // trop tôt

    t.mock.timers.tick(40 * 60_000); // 7 h 30
    const today = Date.parse('2026-10-02T08:00:00Z');
    const before = dms.length;
    mockFetch([login(), json(200, { result: [
        { reservation_id: 1, name: 'T1 - Anglais', start_date: today, end_date: today + 2 * H, rooms: [{ name: 'Salle 12', campus: 'NATION1' }] },
        { reservation_id: 2, name: 'Maths', start_date: today + 24 * H, end_date: today + 26 * H, rooms: [] },
    ] })]);
    await runPersonalCheck(client);
    assert.deepStrictEqual(dms.slice(before).map((d) => [d.id, d.payload.embeds[0].data.title]), [['u3', '☀️ Ton programme du jour']]);
    const digest = dms.at(-1).payload.embeds[0].data.description;
    assert.match(digest, /Anglais\n📍 Salle 12 \(Nation 1\)/);
    assert.doesNotMatch(digest, /Maths/); // demain : pas au programme

    t.mock.timers.tick(15 * 60_000);
    calls = mockFetch([]);
    await runPersonalCheck(client);
    assert.strictEqual(calls.length, 0); // déjà envoyé aujourd'hui
});

test('agenda : un cours qui commence ne fait pas réécrire (ni rechiffrer) la lecture mémorisée', async (t) => {
    // 8 h à Paris ; tous les autres comptes de ce fichier sont mis en sommeil.
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-03T06:00:00Z') });
    const now = Date.now();
    for (const id of ['u1', 'u2', 'u3']) register(id, { grades: false, absences: false, reminders: false, agenda: false, digest: false });
    register('u4', { grades: false, absences: false, reminders: false, agenda: true, digest: false });
    const week = [
        { reservation_id: 1, name: 'Anglais', start_date: now + 0.5 * H, end_date: now + 2 * H, rooms: [] },
        { reservation_id: 2, name: 'Réseaux', start_date: now + 26 * H, end_date: now + 28 * H, rooms: [] },
    ];
    mockFetch([login(), json(200, { result: week })]);
    await runPersonalCheck(client);
    const stored = store.loadData().alerts.u4.agendaSnapshot;
    assert.ok(stored);

    t.mock.timers.tick(61 * 60_000); // le cours d'anglais a commencé, rien d'autre ne change
    mockFetch([json(200, { result: week })]);
    await runPersonalCheck(client);
    assert.strictEqual(store.loadData().alerts.u4.agendaSnapshot, stored);
});

test('reconnexion à un autre compte pendant une lecture : rien de l\'ancien compte n\'est mémorisé', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-04T10:00:00Z') });
    register('u4', { grades: false, absences: false, reminders: false, agenda: false, digest: false });
    register('u5', { grades: true, absences: false, reminders: false, agenda: false, digest: false });
    const responses = [login()];
    globalThis.fetch = async () => {
        const next = responses.shift();
        if (next) return next;
        // Pendant la lecture des notes, u5 refait /login avec un autre compte.
        const data = store.loadData();
        data.users.u5 = { user: encrypt('autre.compte'), pass: encrypt('secret') };
        store.resetAlertHistory(data.alerts.u5);
        return json(200, { result: [{ course: 'Anglais', trimester_name: 'T1', grades: [12] }] });
    };
    await runPersonalCheck(client);
    assert.strictEqual(store.loadData().alerts.u5.knownGrades, undefined);
});

test('MP non remis : une panne de Discord fait réessayer, des MP fermés espacent les lectures', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-05T10:00:00Z') });
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', () => {});
    for (const id of ['u1', 'u2', 'u3', 'u4', 'u5']) register(id, { grades: false, absences: false, reminders: false, agenda: false, digest: false });
    register('u6', { grades: true, absences: false, reminders: false, agenda: false, digest: false });

    let grades = [12];
    let calls = [];
    globalThis.fetch = async (url) => {
        const u = String(url);
        calls.push(u);
        if (u.includes('oauth')) return login();
        if (u.includes('/me/years')) return json(200, { result: [2026] });
        if (u.includes('/grades')) return json(200, { result: [{ course: 'Anglais', trimester_name: 'T1', grades }] });
        throw new Error(`fetch inattendu : ${u}`);
    };
    let failure = null;
    const sent = [];
    const flaky = { users: { fetch: async () => ({ send: async (payload) => {
        if (failure) throw failure;
        sent.push(payload);
    } }) } };
    const known = () => store.loadData().alerts.u6.knownGrades.length;
    const pass = async () => {
        t.mock.timers.tick(61 * 60_000);
        calls = [];
        await runPersonalCheck(flaky);
    };

    await runPersonalCheck(flaky); // premier relevé : mémorisé sans MP
    assert.strictEqual(known(), 1);

    // Discord en panne au moment d'annoncer la note : elle n'est pas perdue.
    grades = [12, 15];
    failure = new Error('ECONNRESET');
    await pass();
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(known(), 1);

    failure = null;
    await pass();
    assert.strictEqual(sent.length, 1);
    assert.match(sent[0].embeds[0].data.fields[0].value, /Note : \*\*15\*\*\/20/);
    // Un bouton sous le MP ouvre /notes, routé comme ceux du tableau de bord.
    assert.deepStrictEqual(sent[0].components[0].toJSON().components.map((b) => b.custom_id), ['hub:notes']);
    assert.strictEqual(known(), 2);

    // MP fermés : la note est abandonnée (réessayer n'y changerait rien)...
    grades = [12, 15, 9];
    failure = Object.assign(new Error('Cannot send messages to this user'), { code: 50007 });
    await pass();
    assert.strictEqual(known(), 3);
    assert.strictEqual(store.loadData().alerts.u6.dmClosed, true);

    // ... et MyGes n'est plus relu qu'une fois par jour.
    await pass();
    assert.ok(!calls.some((u) => u.includes('/grades')));
    t.mock.timers.tick(24 * H);
    failure = null;
    grades = [12, 15, 9, 18];
    await pass();
    assert.ok(calls.some((u) => u.includes('/grades')));
    // Le MP est passé : les MP sont rouverts, retour à une lecture par heure.
    assert.strictEqual(sent.length, 2);
    assert.strictEqual(store.loadData().alerts.u6.dmClosed, undefined);
});

test('MP non remis : fermé, panne passagère ou refus durable', async (t) => {
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', () => {});
    const { sendDM } = dist('utils/dm.js');
    const err = (fields) => Object.assign(new Error('refus'), fields);
    const sendFails = (e) => ({ users: { fetch: async () => ({ send: async () => { throw e; } }) } });
    const result = (e) => sendDM(sendFails(e), 'u', {});

    assert.strictEqual(await result(err({ code: 50007, status: 403 })), 'closed'); // MP fermés
    const gone = { users: { fetch: async () => { throw err({ code: 10013, status: 404 }); } } };
    assert.strictEqual(await sendDM(gone, 'u', {}), 'closed'); // compte supprimé
    assert.strictEqual(await result(err({ code: 50035, status: 400 })), 'failed'); // retenter échouerait encore
    assert.strictEqual(await result(err({ status: 503 })), 'transient');
    assert.strictEqual(await result(err({ status: 429 })), 'transient');
    assert.strictEqual(await result(new Error('ECONNRESET')), 'transient');
});
