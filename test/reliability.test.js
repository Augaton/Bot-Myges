// Fiabilité : mot de passe périmé, panne de MyGes, annonces de projets, moyennes.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const zlib = require('node:zlib');
const { dist, mockFetch, json, redirect } = require('./helpers');

const store = dist('core/store.js');
const mygesData = dist('core/mygesData.js');
const { AuthService } = dist('myges/services/auth.js');
const { BadCredentialsError, MyGesError } = dist('myges/errors.js');
const { ProfileService } = dist('myges/services/profile.js');
const { encrypt } = dist('crypto.js');
const { runProjectCheck } = dist('tasks/projects.js');
const { runPersonalCheck } = dist('tasks/personalAlerts.js');
const { toSubject, generalAverage } = dist('utils/grades.js');

const H = 3_600_000;
const login = () => redirect('x:/#access_token=neuf&token_type=bearer&expires_in=86400');
const quiet = (t) => {
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', () => {});
};

function account(id) {
    const data = store.loadData();
    data.users[id] = { user: encrypt('p.nom'), pass: encrypt('secret') };
    store.saveData(data);
    return data.users[id];
}

/** MyGes simulé : compte les connexions, et répond selon l'adresse. */
function kordis(routes = {}) {
    const seen = { logins: 0, reads: 0 };
    globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes('oauth')) {
            seen.logins++;
            return routes.login ? routes.login() : login();
        }
        seen.reads++;
        for (const [pattern, respond] of Object.entries(routes)) {
            if (u.includes(pattern)) return respond();
        }
        return routes.read ? routes.read() : json(200, { result: [] });
    };
    return seen;
}

const expired = () => ({ token_type: 'bearer', access_token: 'vieux', expires_at: Date.now() - 1_000 });

test('mot de passe changé : un seul essai refusé, même si plusieurs lectures trouvent le token expiré', async (t) => {
    quiet(t);
    account('change');
    store.openSession('change', expired());
    const token = await store.getSession('change');
    const seen = kordis({ login: () => json(401, {}), read: () => json(401, {}) });
    for (let i = 0; i < 4; i++) await ProfileService.getProfile(token).catch(() => {});
    assert.strictEqual(seen.logins, 1);
    assert.strictEqual(store.loginFailure('change'), 'bad-credentials');
    assert.strictEqual(await store.getSession('change'), null);
    assert.strictEqual(seen.logins, 1);
});

test('authentification en panne : pas de nouvel essai avant le délai, puis la session repart', async (t) => {
    quiet(t);
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-01T10:00:00Z') });
    account('panne');
    store.openSession('panne', expired());
    const token = await store.getSession('panne');
    let seen = kordis({ login: () => json(403, {}), read: () => json(401, {}) });
    await ProfileService.getProfile(token).catch(() => {});
    const first = seen.logins;
    await ProfileService.getProfile(token).catch(() => {});
    assert.strictEqual(seen.logins, first);
    assert.strictEqual(store.loginFailure('panne'), 'unavailable');

    t.mock.timers.tick(24 * H);
    seen = kordis({ '/me/profile': () => json(200, { result: { firstname: 'Inès' } }) });
    assert.strictEqual((await ProfileService.getProfile(token)).firstname, 'Inès');
    assert.strictEqual(seen.logins, 1);
    assert.strictEqual(store.loginFailure('panne'), null);
});

test('/login pendant un rafraîchissement : l\'ancien échec ne bloque pas la nouvelle session', async (t) => {
    quiet(t);
    account('course');
    store.openSession('course', expired());
    const token = await store.getSession('course');
    let refuse;
    kordis({ login: () => new Promise((resolve) => { refuse = () => resolve(json(401, {})); }), read: () => json(401, {}) });
    const pending = token.__refresh();
    await new Promise(setImmediate);

    account('course'); // nouveau /login : nouveaux identifiants, nouvelle session
    const fresh = { token_type: 'bearer', access_token: 'nouveau' };
    store.openSession('course', fresh);
    refuse();
    assert.strictEqual(await pending, null);
    assert.strictEqual(store.loginFailure('course'), null);
    assert.strictEqual((await store.getSession('course')).access_token, 'nouveau');
});

test('redirection sans token : une maintenance ne passe pas pour un mauvais mot de passe', async () => {
    mockFetch([redirect('https://authentication.kordis.fr/maintenance')]);
    await assert.rejects(AuthService.generateAccessToken('p.nom', 'x'), (e) => e instanceof MyGesError && !(e instanceof BadCredentialsError));
    mockFetch([redirect('x:/#error=access_denied')]);
    await assert.rejects(AuthService.generateAccessToken('p.nom', 'x'), BadCredentialsError);
    mockFetch([redirect('https://x.fr/cb?error=access_denied')]);
    await assert.rejects(AuthService.generateAccessToken('p.nom', 'x'), BadCredentialsError);
    mockFetch([json(401, {})]);
    await assert.rejects(AuthService.generateAccessToken('p.nom', 'x'), BadCredentialsError);
});

test('documents : une matière relue coup sur coup n\'appelle MyGes qu\'une fois, sans mélange entre comptes', async () => {
    const seen = kordis({ '/files': () => json(200, { result: [{ oc_id: 1 }] }) });
    const token = { token_type: 'bearer', access_token: 't' };
    await mygesData.getCourseFiles('a', token, '42');
    await mygesData.getCourseFiles('a', token, '42');
    assert.strictEqual(seen.reads, 1);
    await mygesData.getCourseFiles('b', token, '42');
    assert.strictEqual(seen.reads, 2);
    mygesData.forgetUser('a');
    await mygesData.getCourseFiles('a', token, '42');
    assert.strictEqual(seen.reads, 3);
});

test('brouillons : invisibles dans les projets comme dans les TP', async () => {
    const items = [{ project_id: 1, name: 'Publié' }, { project_id: 2, name: 'Brouillon', is_draft: true }];
    kordis({ '/projects': () => json(200, { result: items }), '/practicals': () => json(200, { result: items }) });
    const token = { token_type: 'bearer', access_token: 't' };
    const names = (list) => list.map((p) => p.name);
    assert.deepStrictEqual(names(await mygesData.getProjects('draft', token)), ['Publié']);
    assert.deepStrictEqual(names(await mygesData.getAssignments('draft', token)).filter((n) => n === 'Brouillon'), []);
});

function clearAccounts() {
    const data = store.loadData();
    data.users = {};
    data.alerts = {};
    data.guilds = {};
    store.saveData(data);
}

function guild(id, referenceUserId, fields = {}) {
    const data = store.loadData();
    data.guilds[id] = { announcementChannelId: `salon-${id}`, referenceUserId, knownProjectIds: [], ...fields };
    store.saveData(data);
}
const project = (id, extra = {}) => ({ project_id: id, name: `Projet ${id}`, course_name: 'Web', ...extra });

function fakeGuildClient() {
    const posts = [];
    return { posts, channels: { fetch: async (id) => ({ isSendable: () => true, send: async (payload) => posts.push({ id, name: payload.embeds[0].data.fields[0].value }) }) } };
}

test('annonces : MyGes indisponible à la configuration, puis premier cycle réussi sans rafale', async (t) => {
    quiet(t);
    clearAccounts(); // sinon, 5 s de pause entre chaque compte de référence restant
    account('ref1');
    store.openSession('ref1', { token_type: 'bearer', access_token: 't' });
    guild('neuf', 'ref1'); // knownProjectIds resté vide : c'est le cas qui annonçait toute l'année
    const client = fakeGuildClient();

    kordis({ '/projects': () => json(200, { result: [project(1), project(2), project(3, { is_draft: true })] }) });
    await runProjectCheck(client);
    assert.deepStrictEqual(client.posts, []);
    assert.deepStrictEqual(store.loadData().guilds.neuf.knownProjectIds, [1, 2]);

    // Un vrai nouveau projet, et le brouillon enfin publié : les deux sont annoncés.
    mygesData.forgetUser('ref1');
    kordis({ '/projects': () => json(200, { result: [project(1), project(2), project(3), project(4)] }) });
    await runProjectCheck(client);
    assert.deepStrictEqual(client.posts.map((p) => p.name), ['Projet 3', 'Projet 4']);

    mygesData.forgetUser('ref1');
    await runProjectCheck(client);
    assert.strictEqual(client.posts.length, 2, 'pas deux fois');
});

test('annonces : une lecture ratée ne consomme pas l\'amorçage', async (t) => {
    quiet(t);
    clearAccounts(); // sinon, 5 s de pause entre chaque compte de référence restant
    account('ref2');
    store.openSession('ref2', { token_type: 'bearer', access_token: 't' });
    guild('rate', 'ref2');
    const client = fakeGuildClient();
    kordis({ '/projects': () => json(403, {}) });
    await runProjectCheck(client);
    assert.strictEqual(store.getGuildConfig(store.loadData(), 'rate').projectsSeeded, false);

    mygesData.forgetUser('ref2');
    kordis({ '/projects': () => json(200, { result: [project(1)] }) });
    await runProjectCheck(client);
    assert.deepStrictEqual(client.posts, []);
    assert.strictEqual(store.getGuildConfig(store.loadData(), 'rate').projectsSeeded, true);
});

test('annonces : une configuration déjà en service continue d\'annoncer normalement', async (t) => {
    quiet(t);
    clearAccounts(); // sinon, 5 s de pause entre chaque compte de référence restant
    account('ref3');
    store.openSession('ref3', { token_type: 'bearer', access_token: 't' });
    guild('ancien', 'ref3', { knownProjectIds: [1] });
    const client = fakeGuildClient();
    kordis({ '/projects': () => json(200, { result: [project(1), project(2)] }) });
    await runProjectCheck(client);
    assert.deepStrictEqual(client.posts.map((p) => p.name), ['Projet 2']);
});

test('moyenne à 0 : « pas encore noté » sans aucune note, vrai 0 s\'il y en a', () => {
    const empty = toSubject({ course: 'Sans note', average: 0, grades: [], exam: 0, ects: 4 });
    const real = toSubject({ course: 'Vraie note', average: 0, grades: [0], ects: 4 });
    const good = toSubject({ course: 'Bonne note', average: 16, grades: [16], ects: 4 });
    assert.strictEqual(empty.average, null);
    assert.strictEqual(real.average, 0);
    assert.strictEqual(generalAverage([empty, good]), 16);
    assert.strictEqual(generalAverage([real, good]), 8);
});

// Alertes personnelles : test à part, sur leurs propres comptes.
const dmClient = () => {
    const dms = [];
    return { dms, users: { fetch: async (id) => ({ send: async (payload) => dms.push({ id, title: payload.embeds[0].data.title }) }) } };
};

test('mot de passe refusé : un seul MP, plus aucun essai, et un nouveau /login réarme le message', async (t) => {
    quiet(t);
    clearAccounts();
    const client = dmClient();
    account('refuse');
    store.closeSession('refuse');
    const seen = kordis({ login: () => json(401, {}) });
    await runPersonalCheck(client);
    assert.deepStrictEqual(client.dms, [{ id: 'refuse', title: '🔒 Alertes en pause' }]);
    assert.strictEqual(seen.logins, 1);

    await runPersonalCheck(client);
    assert.strictEqual(client.dms.length, 1);
    assert.strictEqual(seen.logins, 1);

    // Nouveau /login, puis mot de passe de nouveau périmé.
    account('refuse');
    store.closeSession('refuse');
    await runPersonalCheck(client);
    assert.strictEqual(client.dms.length, 2);
});

test('MyGes en panne : les rappels partent quand même, avant tout appel, sur la dernière lecture', async (t) => {
    quiet(t);
    clearAccounts();
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-01T10:00:00Z') });
    const now = Date.now();
    const client = dmClient();
    account('rappel');
    store.closeSession('rappel');

    // Lecture réussie : rendu dans 3 jours et demi, pas encore de rappel à faire.
    const steps = [{ psp_id: 1, psp_limit_date: now + 84 * H, psp_type: 'Rendu' }];
    kordis({ '/projects': () => json(200, { result: [{ project_id: 7, name: 'Projet Web', course_name: 'Web', steps }] }) });
    await runPersonalCheck(client);
    assert.deepStrictEqual(client.dms, []);

    // Deux jours et demi plus tard, MyGes est en panne : 24 h restantes, lecture périmée.
    t.mock.timers.tick(60 * H);
    let readsBeforeDm = null;
    const seen = kordis({ login: () => json(403, {}), read: () => json(403, {}) });
    const send = client.users.fetch;
    client.users.fetch = async (id) => {
        readsBeforeDm ??= seen.logins + seen.reads;
        return send(id);
    };
    await runPersonalCheck(client);
    assert.deepStrictEqual(client.dms.map((d) => d.title), ['📅 Rendu demain']);
    assert.strictEqual(readsBeforeDm, 0);

    // Le même rappel ne repart pas au cycle suivant.
    t.mock.timers.tick(61 * 60_000);
    await runPersonalCheck(client);
    assert.strictEqual(client.dms.length, 1);
});

test('fichiers du panel : compressés à la demande, 304 si inchangés, sécurité conservée', async () => {
    const { createPanel } = dist('panel/app.js');
    const server = createPanel({ trustProxy: false });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const get = (path, headers = {}) => new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: server.address().port, path, headers, agent: false }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        }).on('error', reject);
    });

    const plain = await get('/app.js');
    assert.strictEqual(plain.headers['content-encoding'], undefined);
    assert.strictEqual(Number(plain.headers['content-length']), plain.body.length);
    assert.strictEqual(plain.headers.vary, 'Accept-Encoding');

    const packed = await get('/app.js', { 'Accept-Encoding': 'gzip, deflate, br' });
    assert.strictEqual(packed.headers['content-encoding'], 'gzip');
    assert.ok(packed.body.length < plain.body.length / 2, `${packed.body.length} / ${plain.body.length}`);
    assert.deepStrictEqual(zlib.gunzipSync(packed.body), plain.body);
    assert.strictEqual(packed.headers['content-security-policy'], plain.headers['content-security-policy']);

    assert.strictEqual((await get('/app.js', { 'Accept-Encoding': 'gzip;q=0' })).headers['content-encoding'], undefined);
    assert.strictEqual((await get('/icon-192.png', { 'Accept-Encoding': 'gzip' })).headers['content-encoding'], undefined, 'PNG laissé tel quel');

    const fresh = await get('/app.js', { 'If-None-Match': plain.headers.etag });
    assert.strictEqual(fresh.status, 304);
    assert.strictEqual(fresh.body.length, 0);
    assert.ok(fresh.headers['content-security-policy'], 'en-têtes de sécurité sur le 304');
    assert.strictEqual((await get('/app.js', { 'If-None-Match': 'W/"autre"' })).status, 200);
    assert.notStrictEqual(plain.headers.etag, (await get('/style.css')).headers.etag);

    // L'API reste sans cache et sans compression.
    const api = await get('/api/session', { 'Accept-Encoding': 'gzip' });
    assert.strictEqual(api.headers['content-encoding'], undefined);
    assert.strictEqual(api.headers.etag, undefined);
    assert.strictEqual(api.headers['cache-control'], 'no-store');
    await new Promise((resolve) => server.close(resolve));
});
