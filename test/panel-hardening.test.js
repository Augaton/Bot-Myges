// Panel : limites de connexion et disponibilité, derrière un proxy simulé.
process.env.TZ = 'Europe/Paris';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { dist, json, redirect } = require('./helpers');

const { createPanel } = dist('panel/app.js');
const views = dist('panel/views.js');
const { BaseService } = dist('myges/services/base.js');
const { accountKey, VALID_USERNAME } = dist('myges/identifier.js');
const { safeFileName } = dist('utils/documents.js');

const creds = { token_type: 'bearer', access_token: 't' };

let port;
let server;
test.before(() => new Promise((resolve) => {
    server = createPanel({ trustProxy: true });
    server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
    });
}));
test.after(() => server.close());

function call(method, url, { body, cookie, ip = '198.51.100.1' } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const headers = { 'X-Forwarded-For': ip };
        if (payload !== undefined) Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
        if (cookie) headers.Cookie = cookie;
        if (method === 'POST') headers.Origin = `http://127.0.0.1:${port}`;
        const req = http.request({ host: '127.0.0.1', port, method, path: url, headers, agent: false }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject);
        req.end(payload);
    });
}

const login = (username, password, ip) => call('POST', '/api/login', { body: { username, password }, ip });
const cookieOf = (res) => res.headers['set-cookie']?.[0].split(';')[0];
const accepted = () => redirect('x:/#access_token=t&token_type=bearer&expires_in=3600');

/** Kordis simulé : accepte le mot de passe « bon », et compte les essais. */
function kordis(extra = () => null) {
    const state = { logins: 0 };
    globalThis.fetch = async (url, init = {}) => {
        const custom = extra(String(url), init);
        if (custom) return custom;
        if (String(url).endsWith('/me')) return json(200, { result: { normalized_role: 'student', uid: 7 } });
        if (!String(url).includes('oauth')) return json(200, { result: [] });
        state.logins++;
        return Buffer.from(init.headers.Authorization.slice(6), 'base64').toString().endsWith(':bon') ? accepted() : json(401, {});
    };
    return state;
}

const quiet = (t) => {
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', () => {});
};

test('mode proxy : un accès direct au port n\'obtient jamais le formulaire', async () => {
    const res = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/', agent: false }, (r) => {
            const chunks = [];
            r.on('data', (c) => chunks.push(c));
            r.on('end', () => resolve({ status: r.statusCode, text: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject);
        req.end();
    });
    assert.strictEqual(res.status, 403);
    assert.doesNotMatch(res.text, /password|app\.js/);
    assert.match(res.text, /Accès direct refusé/);
});

test('mode proxy : qui vient du proxy passe, un en-tête falsifié depuis Internet non', () => {
    const { isDirectAccess } = dist('panel/app.js');
    assert.strictEqual(isDirectAccess('172.18.0.1', '203.0.113.5'), false);
    assert.strictEqual(isDirectAccess('::ffff:172.18.0.1', '203.0.113.5'), false);
    assert.strictEqual(isDirectAccess('203.0.113.5', '198.51.100.1'), true); // en-tête falsifié
    assert.strictEqual(isDirectAccess('172.18.0.1', undefined), true); // sans proxy devant
});

test('rafale : les essais simultanés respectent la limite par réseau', async (t) => {
    quiet(t);
    const state = kordis();
    await Promise.all(Array.from({ length: 80 }, (_, i) => login(`rafale${i}`, 'x', '203.0.113.5')));
    assert.ok(state.logins <= 20, `${state.logins} essais transmis à MyGes`);
});

test('IPv6 : tout un /64 compte pour un seul visiteur', async (t) => {
    quiet(t);
    const state = kordis();
    await Promise.all(Array.from({ length: 80 }, (_, i) => login(`six${i}`, 'x', `2001:db8:1:2::${(i + 1).toString(16)}`)));
    assert.ok(state.logins <= 20, `${state.logins} essais transmis à MyGes`);
});

test('adresse IPv4 mappée en IPv6 : même visiteur que l\'IPv4', async (t) => {
    quiet(t);
    const state = kordis();
    for (let i = 0; i < 30; i++) await login(`map${i}`, 'x', i % 2 ? '192.0.2.9' : '::ffff:192.0.2.9');
    assert.ok(state.logins <= 20, `${state.logins} essais transmis à MyGes`);
});

test('un attaquant ne bloque pas la connexion des visiteurs d\'autres réseaux', async (t) => {
    quiet(t);
    kordis();
    for (let i = 0; i < 40; i++) await login(`bloque${i}`, 'x', '198.18.0.1');
    assert.strictEqual((await login('innocent', 'bon', '198.19.0.1')).status, 200);
});

test('verrouiller un identifiant depuis un réseau ne bloque pas son titulaire ailleurs', async (t) => {
    quiet(t);
    kordis();
    for (let i = 0; i < 6; i++) await login('victime', 'x', '198.18.1.1');
    assert.strictEqual((await login('victime', 'x', '198.18.1.1')).status, 429);
    assert.strictEqual((await login('victime', 'bon', '198.18.2.1')).status, 200);
});

test('essais répartis sur beaucoup de réseaux : plafond par identifiant', async (t) => {
    quiet(t);
    const state = kordis();
    for (let i = 0; i < 60; i++) await login('reparti', 'x', `192.0.${(i % 200) + 2}.1`);
    assert.ok(state.logins <= 20, `${state.logins} essais sur un même identifiant`);
});

test('connexions en boucle sur son propre compte : limitées, sans éjecter les autres', async (t) => {
    quiet(t);
    kordis();
    const victim = cookieOf(await login('voisin', 'bon', '198.51.100.20'));
    const statuses = [];
    for (let i = 0; i < 15; i++) statuses.push((await login('boucle', 'bon', '198.51.100.21')).status);
    assert.strictEqual(statuses.filter((s) => s === 200).length, 10);
    assert.strictEqual(statuses.at(-1), 429);
    assert.strictEqual((await call('GET', '/api/session', { cookie: victim })).status, 200);
});

test('3 sessions au plus par compte : la plus ancienne est fermée', async (t) => {
    quiet(t);
    kordis();
    const cookies = [];
    for (let i = 0; i < 4; i++) cookies.push(cookieOf(await login('quatre', 'bon', '198.51.100.22')));
    assert.strictEqual((await call('GET', '/api/session', { cookie: cookies[0] })).status, 401);
    assert.strictEqual((await call('GET', '/api/session', { cookie: cookies[3] })).status, 200);
});

test('la limite de requêtes vaut par compte, pas par session', async (t) => {
    quiet(t);
    kordis();
    const a = cookieOf(await login('gourmand', 'bon', '198.51.100.23'));
    const b = cookieOf(await login('gourmand', 'bon', '198.51.100.23'));
    let refused = 0;
    for (let i = 0; i < 140; i++) {
        if ((await call('GET', '/api/session', { cookie: i % 2 ? a : b })).status === 429) refused++;
    }
    assert.ok(refused >= 20, `${refused} refus`);
});

test('téléchargements : un seul par compte, même depuis deux sessions', async (t) => {
    quiet(t);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    kordis((url) => (url.includes('/files/7') ? gate.then(() => new Response('%PDF')) : null));
    const a = cookieOf(await login('double', 'bon', '198.51.100.24'));
    const b = cookieOf(await login('double', 'bon', '198.51.100.24'));
    const first = call('GET', '/api/documents/42/7', { cookie: a });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.strictEqual((await call('GET', '/api/documents/42/7', { cookie: b })).status, 429);
    release();
    assert.strictEqual((await first).status, 200);
});

test('téléchargement : la place reste prise tant que le client n\'a pas fini de recevoir', async (t) => {
    quiet(t);
    const big = Buffer.alloc(20 * 1024 * 1024, 1);
    kordis((url) => (url.includes('/files/7') ? new Response(big) : null));
    const cookie = cookieOf(await login('lent', 'bon', '198.51.100.25'));
    const slow = await new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/api/documents/42/7', headers: { Cookie: cookie, 'X-Forwarded-For': '198.51.100.25' }, agent: false }, (res) => resolve({ req, res }));
        req.end();
    });
    slow.res.pause();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual((await call('GET', '/api/documents/42/7', { cookie })).status, 429);
    slow.req.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual((await call('GET', '/api/documents/42/7', { cookie })).status, 200);
});

test('redirection d\'une réponse MyGes vers une adresse interne : refusée', async () => {
    const calls = [];
    globalThis.fetch = async (url) => {
        calls.push(String(url));
        return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
    };
    await assert.rejects(BaseService.download(creds, '/me/1/files/2', 100));
    await assert.rejects(BaseService.request(creds, 'GET', '/me/x'));
    assert.ok(calls.every((u) => u.startsWith('https://api.kordis.fr')));
});

test('redirection vers MyGes : suivie, le token ne quitte pas son hôte', async () => {
    const calls = [];
    const replies = [
        new Response(null, { status: 302, headers: { location: 'https://ges-dl.kordis.fr/private/a.pdf' } }),
        new Response('%PDF'),
    ];
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), auth: new Headers(init.headers).get('authorization'), redirect: init.redirect });
        return replies.shift();
    };
    const file = await BaseService.download(creds, '/me/1/files/2', 100);
    assert.strictEqual(file.data.toString(), '%PDF');
    assert.strictEqual(calls[0].redirect, 'manual');
    assert.strictEqual(calls[1].url, 'https://ges-dl.kordis.fr/private/a.pdf');
    assert.strictEqual(calls[1].auth, null);
});

test('identifiants : les variantes Unicode d\'un même compte ne donnent pas plus d\'essais', () => {
    assert.strictEqual(accountKey('p.nom'), accountKey('P.Nom'));
    assert.strictEqual(accountKey('p.nom'), accountKey('p\u0301.nom'));
    assert.strictEqual(accountKey('p.nom'), accountKey('p.n\u034Fom'));
    for (const hidden of ['\u200B', '\u00AD', '\u2060', '\uFEFF']) assert.strictEqual(VALID_USERNAME.test(`p.${hidden}nom`), false, hidden.codePointAt(0).toString(16));
    assert.strictEqual(VALID_USERNAME.test('p.nom'), true);
    assert.strictEqual(VALID_USERNAME.test('p.nom-durand'), true);
});

test('vues : une réponse MyGes démesurée ne gèle pas le panel', () => {
    const rows = Array.from({ length: 40_000 }, (_, i) => ({ course: `Matière ${i}`, trimester_name: `Semestre ${i}`, grades: [10] }));
    const started = performance.now();
    views.notesView(rows);
    assert.ok(performance.now() - started < 1_000, `${Math.round(performance.now() - started)} ms`);
});

test('nom de fichier : couper dans un emoji ne casse pas l\'en-tête', () => {
    assert.doesNotThrow(() => encodeURIComponent(safeFileName('😀'.repeat(60))));
    assert.doesNotThrow(() => encodeURIComponent(safeFileName(`${'😀'.repeat(60)}a`)));
});

test('URL illisible : 400 sans trace dans le journal', async (t) => {
    const errors = t.mock.method(console, 'error', () => {});
    const res = await call('GET', '//');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(errors.mock.callCount(), 0);
});
