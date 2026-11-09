// Années passées dans le panel : seules celles que MyGes propose, vérifiées côté serveur.
process.env.TZ = 'Europe/Paris';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { dist, json, redirect } = require('./helpers');

const { createPanel } = dist('panel/app.js');
const { getCurrentYear } = dist('utils/schoolYear.js');

const current = Number(getCurrentYear());
const past = current - 1;
let urls = [];

/** MyGes simulé : années [past, current], notes et absences différentes selon l'année. */
function kordis({ years = () => json(200, { result: [past, current] }) } = {}) {
    urls = [];
    globalThis.fetch = async (url) => {
        const u = String(url);
        urls.push(u);
        if (u.includes('oauth')) return redirect('x:/#access_token=t&token_type=bearer&expires_in=3600');
        if (u.endsWith('/me')) return json(200, { result: { normalized_role: 'student', uid: 7 } });
        if (u.endsWith('/me/years')) return years();
        if (u.endsWith(`/me/${past}/grades`)) return json(200, { result: [{ course: 'T1 - Ancienne matière', trimester_name: 'Semestre 1', average: 15, grades: [15] }] });
        if (u.endsWith(`/me/${current}/grades`)) return json(200, { result: [{ course: 'T1 - Matière actuelle', trimester_name: 'Semestre 1', average: 12, grades: [12] }] });
        if (u.endsWith(`/me/${past}/courses`)) return json(200, { result: [{ rc_id: 77, name: 'Ancien cours', has_documents: true, trimester: 'Semestre 1' }] });
        return json(200, { result: [] });
    };
}

let server;
let port;
let cookie = '';
test.before(() => new Promise((resolve) => {
    server = createPanel({ trustProxy: false });
    server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
    });
}));
test.after(() => server.close());

function call(method, path, body) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const headers = { ...(cookie ? { Cookie: cookie } : {}) };
        if (payload !== undefined) Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Origin: `http://127.0.0.1:${port}` });
        const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const set = res.headers['set-cookie']?.[0];
                if (set) cookie = set.split(';')[0];
                const text = Buffer.concat(chunks).toString();
                resolve({ status: res.statusCode, json: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : null });
            });
        });
        req.on('error', reject);
        req.end(payload);
    });
}

async function signIn(t, username) {
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', () => {});
    cookie = '';
    assert.strictEqual((await call('POST', '/api/login', { username, password: 'x' })).status, 200);
    urls = [];
}

test('années : la liste de MyGes, la plus récente d\'abord', async (t) => {
    kordis();
    await signIn(t, 'annees.liste');
    const res = await call('GET', '/api/annees');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json, { current: String(current), years: [String(current), String(past)] });
});

test('notes et absences : l\'année demandée est lue, l\'année en cours par défaut', async (t) => {
    kordis();
    await signIn(t, 'annees.notes');
    const now = await call('GET', '/api/notes');
    assert.match(JSON.stringify(now.json), /Matière actuelle/);

    const before = await call('GET', `/api/notes?year=${past}`);
    assert.strictEqual(before.status, 200);
    assert.match(JSON.stringify(before.json), /Ancienne matière/);
    assert.doesNotMatch(JSON.stringify(before.json), /Matière actuelle/);

    urls = [];
    assert.strictEqual((await call('GET', `/api/absences?year=${past}`)).status, 200);
    assert.ok(urls.some((u) => u.endsWith(`/me/${past}/absences`)), urls.join(' '));
});

test('documents : cours et documents annuels de l\'année choisie', async (t) => {
    kordis();
    await signIn(t, 'annees.docs');
    const sources = await call('GET', `/api/documents?year=${past}`);
    assert.strictEqual(sources.status, 200);
    assert.ok(sources.json.some((s) => s.name.includes('Ancien cours')), JSON.stringify(sources.json));
    urls = [];
    assert.strictEqual((await call('GET', `/api/documents/annual?year=${past}`)).status, 200);
    assert.ok(urls.some((u) => u.endsWith(`/me/${past}/annualDocuments`)), urls.join(' '));
});

test('année hors liste ou mal formée : refusée, sans appel à MyGes pour cette année', async (t) => {
    kordis();
    await signIn(t, 'annees.refus');
    assert.strictEqual((await call('GET', `/api/notes?year=${current - 7}`)).status, 404);
    assert.strictEqual((await call('GET', `/api/notes?year=${current + 1}`)).status, 404);
    assert.strictEqual((await call('GET', '/api/notes?year=20x5')).status, 400);
    assert.strictEqual((await call('GET', '/api/notes?year=../me')).status, 400);
    assert.ok(!urls.some((u) => u.includes(`/me/${current - 7}/`) || u.includes(`/me/${current + 1}/`)), urls.join(' '));
});

test('MyGes ne donne pas les années : les dernières sont proposées, une année vide reste lisible', async (t) => {
    kordis({ years: () => json(403, {}) });
    await signIn(t, 'annees.repli');
    const res = await call('GET', '/api/annees');
    assert.strictEqual(res.json.years.length, 5);
    assert.strictEqual(res.json.years[0], String(current));
    const empty = await call('GET', `/api/notes?year=${current - 3}`);
    assert.strictEqual(empty.status, 200);
    assert.deepStrictEqual(empty.json, []);
});
