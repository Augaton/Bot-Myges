// Durcissement : injections, fuites entre comptes, consommation bornée.
const test = require('node:test');
const assert = require('node:assert');
const { dist, mockFetch, json, redirect } = require('./helpers');

const { AuthService } = dist('myges/services/auth.js');
const { buildIcs, escapeText } = dist('utils/ics.js');
const { TtlCache } = dist('utils/ttlCache.js');
const { RateLimiter } = dist('utils/rateLimit.js');
const { fetchPhotoBuffer } = dist('utils/photo.js');
const { log, logError } = dist('utils/logger.js');
const mygesData = dist('core/mygesData.js');
const store = dist('core/store.js');
const { encrypt } = dist('crypto.js');
const campus = dist('commands/campus.js').default;
const { renderAgendaWeek, shutdownRenderPool } = dist('utils/renderPool.js');

const token = { token_type: 'bearer', access_token: 't' };
const accepted = () => redirect('x:/#access_token=t&token_type=bearer&expires_in=3600');
const sentCredentials = (call) => Buffer.from(call.init.headers.Authorization.replace('Basic ', ''), 'base64');

test('ICS : le point-virgule est échappé (RFC 5545)', () => {
    assert.strictEqual(escapeText('a;b').length, 4);
    assert.strictEqual(escapeText('a;b'), String.raw`a\;b`);
});

test('ICS : un retour chariot seul ne peut pas ajouter de ligne', () => {
    assert.doesNotMatch(escapeText('Cours\rATTENDEE:x'), /\r/);
});

test('ICS : l\'identifiant de réservation ne peut pas injecter de propriété', () => {
    const ics = buildIcs([{ reservation_id: '1\r\nATTENDEE:mailto:x@y', name: 'Cours', start_date: 0, end_date: 1000 }]);
    assert.doesNotMatch(ics, /^ATTENDEE/m);
});

test('authentification : mot de passe hors Latin-1 (€) envoyé en UTF-8, sans planter', async () => {
    const calls = mockFetch([accepted()]);
    await AuthService.generateAccessToken('p.nom', 'mot€');
    assert.strictEqual(sentCredentials(calls[0]).toString('utf-8'), 'p.nom:mot€');
});

test('authentification : mot de passe Latin-1 envoyé comme avant', async () => {
    const calls = mockFetch([accepted()]);
    await AuthService.generateAccessToken('p.nom', 'é');
    assert.strictEqual(sentCredentials(calls[0]).toString('latin1'), 'p.nom:é');
});

test('cache : une lecture en cours pendant une déconnexion ne ressort pas au compte suivant', async () => {
    let release;
    globalThis.fetch = () => new Promise((resolve) => { release = resolve; });
    const before = mygesData.getGrades('race', token);
    await new Promise(setImmediate);
    mygesData.forgetUser('race'); // /logout ou /login vers un autre compte
    const next = mygesData.getGrades('race', { ...token, access_token: 'autre' });
    await new Promise(setImmediate);
    const second = release;
    assert.notStrictEqual(second, undefined);
    second(json(200, { result: [{ course: 'nouveau compte' }] }));
    assert.deepStrictEqual(await next, [{ course: 'nouveau compte' }]);
    assert.ok(before); // la promesse d'origine n'est plus partagée
});

test('cache : la réponse de l\'ancien compte n\'est pas remise en cache après coup', async () => {
    let release;
    globalThis.fetch = () => new Promise((resolve) => { release = resolve; });
    const old = mygesData.getGrades('race2', token);
    await new Promise(setImmediate);
    mygesData.forgetUser('race2');
    release(json(200, { result: [{ course: 'ancien compte' }] }));
    await old;

    const calls = mockFetch([json(200, { result: [{ course: 'nouveau' }] })]);
    assert.deepStrictEqual(await mygesData.getGrades('race2', token), [{ course: 'nouveau' }]);
    assert.strictEqual(calls.length, 1);
});

test('cache mémoire : les entrées expirées sont libérées, même jamais relues', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1000 });
    const cache = new TtlCache(100);
    cache.set('notes-de-a', 1);
    t.mock.timers.tick(200);
    cache.set('autre', 2);
    assert.deepStrictEqual([...cache.map.keys()], ['autre']);
});

test('limiteur : au-delà du seuil refuse, puis laisse repasser une fois la fenêtre écoulée', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1000 });
    const limiter = new RateLimiter(2, 1000);
    assert.deepStrictEqual([limiter.hit('a'), limiter.hit('a'), limiter.hit('a'), limiter.hit('b')], [true, true, false, true]);
    t.mock.timers.tick(1001);
    assert.strictEqual(limiter.hit('a'), true);
});

test('limiteur : un utilisateur inactif ne reste pas en mémoire', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1000 });
    const limiter = new RateLimiter(2, 1000);
    limiter.hit('parti');
    t.mock.timers.tick(1001);
    limiter.hit('autre');
    assert.deepStrictEqual([...limiter.hits.keys()], ['autre']);
});

test('photo : un fichier démesuré est ignoré, annoncé ou non', async (t) => {
    t.mock.method(console, 'error', () => {});
    const big = 'x'.repeat(3 * 1024 * 1024);
    mockFetch([new Response('x', { headers: { 'content-length': String(big.length) } })]);
    assert.strictEqual(await fetchPhotoBuffer('https://api.kordis.fr/a.jpg', token, new Map()), null);
    mockFetch([new Response(big)]);
    assert.strictEqual(await fetchPhotoBuffer('https://api.kordis.fr/b.jpg', token, new Map()), null);
});

test('photo : le cache d\'une navigation reste borné', async () => {
    const cache = new Map();
    mockFetch(Array.from({ length: 40 }, () => new Response('x')));
    for (let i = 0; i < 40; i++) await fetchPhotoBuffer(`https://api.kordis.fr/${i}.jpg`, token, cache);
    assert.ok(cache.size <= 30);
});

test('journal : un saut de ligne venu de MyGes ne fabrique pas de fausse ligne', (t) => {
    const lines = [];
    t.mock.method(console, 'log', (l) => lines.push(l));
    t.mock.method(console, 'error', (l) => lines.push(l));
    log('PROJET', 'Projet "x\r\n[01/01 00:00:00] [AUTH] faux"');
    logError('PROJET', 'Projet "x\n[AUTH] faux"');
    assert.ok(lines.every((l) => !/[\r\n]/.test(l)));
});

/** Exécute /campus avec un faux Discord ; renvoie le dernier affichage. */
async function runCampus(userId) {
    const replies = [];
    await campus.execute({
        user: { id: userId },
        client: { user: null },
        deferReply: async () => {},
        reply: async (r) => replies.push(r),
        editReply: async (r) => replies.push(r),
    });
    return replies.at(-1);
}

test('/campus : pas de codes pour un compte dont MyGes refuse le mot de passe', async () => {
    const data = store.loadData();
    data.users.ancien = { user: encrypt('p.nom'), pass: encrypt('perime') };
    store.saveData(data);
    mockFetch([json(401, {})]);
    const reply = await runCampus('ancien');
    assert.match(String(reply), /refuse tes identifiants/);
});

/** Compte connecté dont l'agenda contient ces campus. */
async function campusFor(userId, campuses) {
    const data = store.loadData();
    data.users[userId] = { user: encrypt('p.nom'), pass: encrypt('ok') };
    store.saveData(data);
    store.openSession(userId, token);
    const rooms = campuses.map((campus) => ({ name: 'Salle', campus }));
    mockFetch([json(200, { result: campuses.length ? [{ reservation_id: 1, rooms }] : [] })]);
    return runCampus(userId);
}

test('/campus : codes affichés à qui a cours sur l\'un de ces campus', async () => {
    assert.ok((await campusFor('nation', ['NATION1'])).embeds);
    assert.ok((await campusFor('erard', ['Erard'])).embeds);
    assert.ok((await campusFor('multi', ['REIMS', 'VOLTAIRE2'])).embeds);
});

test('/campus : pas de codes pour un étudiant d\'un autre campus ou sans cours', async (t) => {
    t.mock.method(console, 'log', () => {});
    assert.match(String(await campusFor('reims', ['REIMS'])), /réservés/);
    assert.match(String(await campusFor('vide', [])), /réservés/);
});

test('/campus : sans confirmation de MyGes, pas de codes', async (t) => {
    t.mock.method(console, 'error', () => {});
    const account = (id) => {
        const data = store.loadData();
        data.users[id] = { user: encrypt('p.nom'), pass: encrypt('ok') };
        store.saveData(data);
    };
    for (const [id, status] of [['p503', 503], ['p403', 403], ['p429', 429]]) {
        account(id);
        mockFetch([json(status, {})]); // la reconnexion échoue
        assert.strictEqual((await runCampus(id)).embeds, undefined, `connexion HTTP ${status}`);
    }

    account('agenda403');
    store.openSession('agenda403', token);
    mockFetch([json(403, {})]); // session ouverte, lecture de l'agenda refusée
    assert.strictEqual((await runCampus('agenda403')).embeds, undefined);
});

test('rendu : une rafale est refusée au-delà de la file, sans empêcher les autres d\'aboutir', async (t) => {
    t.mock.method(console, 'log', () => {});
    const results = await Promise.allSettled(Array.from({ length: 40 }, () => renderAgendaWeek([], new Date('2026-11-02'))));
    await shutdownRenderPool();
    const done = results.filter((r) => r.status === 'fulfilled').length;
    assert.ok(done >= 2 && done <= 18, `${done} rendus aboutis`);
    assert.match(results.find((r) => r.status === 'rejected').reason.message, /saturée/);
});
