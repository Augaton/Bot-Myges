// « Rester connecté » : un fichier volé ne donne rien, un redémarrage ne déconnecte pas.
process.env.TZ = 'Europe/Paris';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { dist, json, redirect } = require('./helpers');

const { createPanel } = dist('panel/app.js');
const { Sessions } = dist('panel/sessions.js');

const TOKEN = 'token-kordis-secret';
const USERNAME = 'i.morel';

let lastAuthorization;

function kordis({ apiStatus = 200 } = {}) {
    lastAuthorization = undefined;
    globalThis.fetch = async (url, init) => {
        const u = String(url);
        if (u.endsWith('/grades')) lastAuthorization = init?.headers?.Authorization;
        if (u.includes('oauth')) return redirect(`x:/#access_token=${TOKEN}&token_type=bearer&expires_in=3600`);
        if (u.endsWith('/me')) return json(200, { result: { normalized_role: 'student', uid: 7 } });
        if (u.endsWith('/me/profile')) return json(200, { result: { firstname: 'Inès', name: 'Morel' } });
        if (u.endsWith('/grades') && apiStatus !== 200) return json(apiStatus, {});
        return json(200, { result: [] });
    };
}

function start(file) {
    return new Promise((resolve) => {
        const server = createPanel({ trustProxy: false, sessionsFile: file });
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}
const stop = ({ server }) => new Promise((resolve) => server.close(resolve));

function call({ port }, method, url, { body, cookie } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const headers = {};
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

const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'panel-sessions-')), 'panel_sessions.json');
const login = (panel, remember) => call(panel, 'POST', '/api/login', { body: { username: USERNAME, password: 'motdepasse', remember } });
const cookieOf = (res) => res.headers['set-cookie'][0].split(';')[0];
const quiet = (t) => {
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', () => {});
};

test('par défaut : cookie de session du navigateur, rien sur disque, un redémarrage déconnecte', async (t) => {
    quiet(t);
    kordis();
    const file = tempFile();
    let panel = await start(file);
    const res = await login(panel, undefined);
    assert.doesNotMatch(res.headers['set-cookie'][0], /Max-Age/);
    assert.strictEqual(fs.existsSync(file), false);
    const cookie = cookieOf(res);
    assert.strictEqual((await call(panel, 'GET', '/api/session', { cookie })).status, 200);
    await stop(panel);

    panel = await start(file);
    assert.strictEqual((await call(panel, 'GET', '/api/session', { cookie })).status, 401);
    await stop(panel);
});

test('seul true active « Rester connecté »', async (t) => {
    quiet(t);
    kordis();
    const file = tempFile();
    const panel = await start(file);
    for (const remember of ['true', 1, {}, null]) {
        assert.doesNotMatch((await login(panel, remember)).headers['set-cookie'][0], /Max-Age/);
    }
    assert.strictEqual(fs.existsSync(file), false);
    await stop(panel);
});

test('rester connecté : survit au redémarrage, cookie limité à la durée du token', async (t) => {
    quiet(t);
    kordis();
    const file = tempFile();
    let panel = await start(file);
    const res = await login(panel, true);
    const set = res.headers['set-cookie'][0];
    const maxAge = Number(set.match(/Max-Age=(\d+)/)[1]);
    assert.ok(maxAge > 3500 && maxAge <= 3600, String(maxAge));
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict']) assert.ok(set.includes(flag), flag);
    const cookie = cookieOf(res);
    await stop(panel);

    panel = await start(file);
    const session = await call(panel, 'GET', '/api/session', { cookie });
    assert.strictEqual(session.status, 200);
    assert.strictEqual(JSON.parse(session.text).name, 'Inès Morel');
    // Le token restauré sert vraiment : c'est lui qui part vers MyGes.
    assert.strictEqual((await call(panel, 'GET', '/api/notes', { cookie })).status, 200);
    assert.match(lastAuthorization, new RegExp(`^bearer ${TOKEN}$`, 'i'));
    await stop(panel);
});

test('le fichier volé ne donne rien : ni token, ni nom, ni compte, ni cookie, et il n\'est lisible que par le bot', async (t) => {
    quiet(t);
    kordis();
    const file = tempFile();
    const panel = await start(file);
    const cookie = cookieOf(await login(panel, true)).split('=')[1];
    await stop(panel);

    const raw = fs.readFileSync(file, 'utf-8');
    for (const secret of [TOKEN, USERNAME, 'Morel', 'Inès', 'motdepasse', cookie]) assert.ok(!raw.includes(secret), secret);
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    const [id] = Object.keys(JSON.parse(raw).sessions);
    assert.strictEqual(id, crypto.createHash('sha256').update(cookie).digest('hex'));

    // Connaître l'empreinte ne suffit pas : elle ne sert pas de cookie.
    const again = await start(file);
    assert.strictEqual((await call(again, 'GET', '/api/session', { cookie: `__Host-panel=${id}` })).status, 401);
    await stop(again);
});

test('une entrée altérée ou recopiée sous une autre empreinte est refusée, sans panne', async (t) => {
    quiet(t);
    kordis();
    const file = tempFile();
    let panel = await start(file);
    const cookie = cookieOf(await login(panel, true));
    await stop(panel);

    const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const [id] = Object.keys(saved.sessions);
    const entry = saved.sessions[id];
    entry.content = (entry.content[0] === '0' ? '1' : '0') + entry.content.slice(1);
    fs.writeFileSync(file, JSON.stringify(saved));
    panel = await start(file);
    assert.strictEqual((await call(panel, 'GET', '/api/session', { cookie })).status, 401);
    await stop(panel);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')).sessions, {});
});

test('fichier corrompu : le panel démarre quand même, et il repart d\'un fichier propre', async (t) => {
    quiet(t);
    kordis();
    const file = tempFile();
    fs.writeFileSync(file, '{pas du json');
    const panel = await start(file);
    assert.strictEqual((await call(panel, 'GET', '/')).status, 200);
    const cookie = cookieOf(await login(panel, true));
    assert.strictEqual((await call(panel, 'GET', '/api/session', { cookie })).status, 200);
    assert.ok(Object.keys(JSON.parse(fs.readFileSync(file, 'utf-8')).sessions).length === 1);
    await stop(panel);
});

test('déconnexion : l\'entrée disparaît du disque, le cookie ne sert plus après redémarrage', async (t) => {
    quiet(t);
    kordis();
    const file = tempFile();
    let panel = await start(file);
    const cookie = cookieOf(await login(panel, true));
    assert.strictEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf-8')).sessions).length, 1);
    await call(panel, 'POST', '/api/logout', { cookie, body: {} });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')).sessions, {});
    await stop(panel);

    panel = await start(file);
    assert.strictEqual((await call(panel, 'GET', '/api/session', { cookie })).status, 401);
    await stop(panel);
});

test('token refusé par MyGES : la session gardée est effacée', async (t) => {
    quiet(t);
    kordis();
    const file = tempFile();
    const panel = await start(file);
    const cookie = cookieOf(await login(panel, true));
    kordis({ apiStatus: 401 });
    assert.strictEqual((await call(panel, 'GET', '/api/notes', { cookie })).status, 401);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')).sessions, {});
    await stop(panel);
});

test('token expiré : refus au redémarrage et entrée ignorée', async (t) => {
    quiet(t);
    kordis();
    const file = tempFile();
    let panel = await start(file);
    const cookie = cookieOf(await login(panel, true));
    await stop(panel);

    const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
    for (const entry of Object.values(saved.sessions)) entry.expiresAt = Date.now() - 1000;
    fs.writeFileSync(file, JSON.stringify(saved));
    panel = await start(file);
    assert.strictEqual((await call(panel, 'GET', '/api/session', { cookie })).status, 401);
    await stop(panel);
});

test('sans fichier configuré : tout reste en mémoire, même si la case est cochée', async (t) => {
    quiet(t);
    kordis();
    const panel = await start(undefined);
    const res = await login(panel, true);
    assert.doesNotMatch(res.headers['set-cookie'][0], /Max-Age/);
    assert.strictEqual((await call(panel, 'GET', '/api/session', { cookie: cookieOf(res) })).status, 200);
    await stop(panel);
});

const entries = (file) => Object.keys(JSON.parse(fs.readFileSync(file, 'utf-8')).sessions).length;

test('plafond de 3 sessions par compte : la plus ancienne disparaît aussi du disque', async (t) => {
    quiet(t);
    kordis();
    const file = tempFile();
    const panel = await start(file);
    const cookies = [];
    for (let i = 0; i < 4; i++) cookies.push(cookieOf(await login(panel, true)));
    assert.strictEqual(entries(file), 3);
    assert.strictEqual((await call(panel, 'GET', '/api/session', { cookie: cookies[0] })).status, 401);
    assert.strictEqual((await call(panel, 'GET', '/api/session', { cookie: cookies[3] })).status, 200);
    await stop(panel);
});

test('plafond après un redémarrage : il s\'applique dès que le cookie rend le compte lisible', async (t) => {
    quiet(t);
    kordis();
    const file = tempFile();
    let panel = await start(file);
    const cookies = [];
    for (let i = 0; i < 3; i++) cookies.push(cookieOf(await login(panel, true)));
    await stop(panel);

    panel = await start(file);
    cookies.push(cookieOf(await login(panel, true))); // le compte des entrées est encore illisible
    assert.strictEqual(entries(file), 4);
    for (const cookie of cookies.slice(0, 3)) await call(panel, 'GET', '/api/session', { cookie });
    assert.strictEqual(entries(file), 3);
    await stop(panel);
});

test('mémoire pleine : une session gardée sur disque part la première, et elle revient sans déconnexion', (t) => {
    quiet(t);
    const file = tempFile();
    const sessions = new Sessions(file);
    const token = { token_type: 'bearer', access_token: 't', expires_at: Date.now() + 3_600_000 };
    const kept = sessions.open(token, 'Gardée', 'gardee', 1, true).cookie;
    const oldest = sessions.open(token, 'Ancienne', 'ancienne', 2).cookie;
    for (let i = 0; i < 1998; i++) sessions.open(token, 'Autre', `compte${i}`, i);
    assert.strictEqual(sessions.map.size, 2000);

    sessions.open(token, 'Nouvelle', 'nouvelle', 3);
    assert.strictEqual(sessions.map.size, 2000);
    assert.strictEqual(sessions.get(oldest)?.name, 'Ancienne');
    assert.strictEqual(sessions.get(kept)?.name, 'Gardée');
    assert.ok(sessions.map.size <= 2000);
});
