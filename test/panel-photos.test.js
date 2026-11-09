// Photos du panel et commande /panel : aucune image écrite, aucun annuaire de l'école.
process.env.TZ = 'Europe/Paris';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { dist, json, redirect } = require('./helpers');

const { createPanel } = dist('panel/app.js');
const { imageType } = dist('utils/photo.js');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const OWN = 'https://ges-dl.kordis.fr/public/moi.jpg';
const MATE = 'https://ges-dl.kordis.fr/public/camarade.jpg';
const TEAM = 'https://ges-dl.kordis.fr/public/equipier.jpg';
const PROF = 'https://ges-dl.kordis.fr/public/intervenant.jpg';

let port;
let server;
test.before(() => new Promise((resolve) => {
    server = createPanel({ trustProxy: false });
    server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
    });
}));
test.after(() => server.close());

function call(method, url, { body, cookie } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const headers = {};
        if (payload !== undefined) Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Origin: `http://127.0.0.1:${port}` });
        if (cookie) headers.Cookie = cookie;
        const req = http.request({ host: '127.0.0.1', port, method, path: url, headers, agent: false }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        req.end(payload);
    });
}

/** MyGes simulé, avec le détail des adresses demandées. */
function myges(overrides = {}) {
    const calls = [];
    const photos = { [OWN]: new Response(JPEG), [MATE]: new Response(JPEG), [TEAM]: new Response(JPEG), [PROF]: new Response(JPEG), ...overrides };
    globalThis.fetch = async (url) => {
        const u = String(url);
        calls.push(u);
        if (u in photos) return photos[u].clone();
        if (u.includes('oauth')) return redirect('x:/#access_token=t&token_type=bearer&expires_in=3600');
        if (u.endsWith('/me')) return json(200, { result: { normalized_role: 'student', uid: 7 } });
        if (u.endsWith('/me/profile')) return json(200, { result: { firstname: 'Ada', name: 'L', _links: { photo: { href: overrides.own ?? OWN } } } });
        if (u.endsWith('/classes')) return json(200, { result: [{ puid: 3 }] });
        if (u.endsWith('/teachers')) return json(200, { result: [{ uid: 20, firstname: 'Marie', lastname: 'Curie', email: 'marie@ecole.test', links: [{ rel: 'photo', href: PROF }] }] });
        if (u.endsWith('/me/classes/3/students')) return json(200, { result: [{ uid: 8, email: 'camarade@ecole.test', links: [{ rel: 'photo', href: MATE }] }] });
        if (u.endsWith('/me/students/9')) return json(200, { result: { uid: 9, email: 'equipier@ecole.test', _links: { photo: { href: TEAM } } } });
        if (u.endsWith('/projects')) return json(200, { result: [{ project_id: 1, groups: [{ project_group_id: 5, project_group_students: [{ u_id: 9 }] }] }, { project_id: 2, is_draft: true, groups: [{ project_group_id: 6, project_group_students: [{ u_id: 77 }] }] }] });
        return json(200, { result: [] });
    };
    return calls;
}

let logins = 0;
async function signIn() {
    const res = await call('POST', '/api/login', { body: { username: `photos${logins++}`, password: 'x' } });
    assert.strictEqual(res.status, 200);
    return res.headers['set-cookie'][0].split(';')[0];
}

test('sa photo, celle d\'un camarade, celle d\'un équipier : relayées sans être gardées', async () => {
    myges();
    const cookie = await signIn();
    for (const who of ['moi', '7', '8', '9']) {
        const res = await call('GET', `/api/photos/${who}`, { cookie });
        assert.strictEqual(res.status, 200, who);
        assert.strictEqual(res.headers['content-type'], 'image/jpeg');
        assert.strictEqual(res.headers['cache-control'], 'no-store');
        assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
        assert.ok(res.body.equals(JPEG), who);
    }
});

test('annuaire : un inconnu n\'est jamais cherché sur MyGES', async () => {
    const calls = myges();
    const cookie = await signIn();
    assert.strictEqual((await call('GET', '/api/photos/12345', { cookie })).status, 404);
    assert.ok(!calls.some((u) => u.includes('/me/students/')), 'aucune fiche demandée');
});

test('annuaire : un membre d\'un projet en brouillon reste inconnu', async () => {
    const calls = myges();
    const cookie = await signIn();
    assert.strictEqual((await call('GET', '/api/photos/77', { cookie })).status, 404);
    assert.ok(!calls.some((u) => u.includes('/me/students/77')));
});

test('adresses refusées : autre chose qu\'un identifiant, ou une adresse hors MyGES', async (t) => {
    t.mock.method(console, 'error', () => {});
    const calls = myges({ own: 'https://evil.example/x.jpg' });
    const cookie = await signIn();
    assert.strictEqual((await call('GET', '/api/photos/moi', { cookie })).status, 404);
    assert.ok(!calls.some((u) => u.includes('evil.example')));
    for (const url of ['/api/photos/..%2f..%2fprofile', '/api/photos/https%3A%2F%2Fevil.example', '/api/photos/8/x', '/api/photos/-1']) {
        assert.strictEqual((await call('GET', url, { cookie })).status, 404, url);
    }
});

test('contenu hostile : du HTML ou du SVG ne passe pas pour une photo', async () => {
    myges({ [OWN]: new Response('<script>alert(1)</script>', { headers: { 'content-type': 'image/jpeg' } }) });
    const cookie = await signIn();
    assert.strictEqual((await call('GET', '/api/photos/moi', { cookie })).status, 404);
    myges({ [OWN]: new Response('<svg onload="alert(1)"/>', { headers: { 'content-type': 'image/svg+xml' } }) });
    assert.strictEqual((await call('GET', '/api/photos/7', { cookie })).status, 404);
});

test('aucune adresse ni e-mail de MyGES n\'atteint le navigateur', async () => {
    myges();
    const cookie = await signIn();
    const res = await call('GET', '/api/photos/8', { cookie });
    const text = JSON.stringify(res.headers) + res.body.toString('latin1');
    for (const secret of ['kordis', 'ges-dl', 'ecole.test']) assert.ok(!text.includes(secret), secret);
});

test('CSP : images du panel seulement', async () => {
    const page = await call('GET', '/');
    const csp = page.headers['content-security-policy'];
    assert.match(csp, /img-src 'self'/);
    assert.doesNotMatch(csp, /img-src[^;]*(https?:|data:|blob:|\*)/);
});

test('imageType : le contenu décide, pas le nom', () => {
    assert.strictEqual(imageType(JPEG), 'image/jpeg');
    assert.strictEqual(imageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'image/png');
    assert.strictEqual(imageType(Buffer.from('GIF89a')), 'image/gif');
    assert.strictEqual(imageType(Buffer.from('RIFF0000WEBPVP8 ')), 'image/webp');
    for (const bad of ['<svg/>', '<html>', 'RIFF0000WAVE', '']) assert.strictEqual(imageType(Buffer.from(bad)), null, bad);
});

test('/panel : lien privé, seulement en https, jamais de panne visible', async () => {
    const panel = dist('commands/panel.js').default;
    const before = process.env.PANEL_PUBLIC_URL;
    const run = async () => {
        const replies = [];
        await panel.execute({ reply: async (r) => replies.push(r) });
        return replies[0];
    };

    delete process.env.PANEL_PUBLIC_URL;
    assert.match((await run()).content, /pas disponible/);
    process.env.PANEL_PUBLIC_URL = 'http://exemple.test';
    assert.match((await run()).content, /pas disponible/);

    process.env.PANEL_PUBLIC_URL = 'https://exemple.test:8443';
    const reply = await run();
    const embed = reply.embeds[0].toJSON();
    assert.match(embed.description, /https:\/\/exemple\.test:8443/);
    assert.match(embed.footer.text, /non officiel/);
    assert.ok(reply.flags, 'visible par l\'élève seul');

    if (before === undefined) delete process.env.PANEL_PUBLIC_URL;
    else process.env.PANEL_PUBLIC_URL = before;
});

test('/panel est enregistrée et citée dans l\'aide', () => {
    const { commandsJSON } = dist('core/registry.js');
    assert.ok(commandsJSON.some((c) => c.name === 'panel'));
});

test('annuaire : photo d\'un intervenant permise, e-mail des seuls intervenants', async () => {
    myges();
    const cookie = await signIn();
    assert.strictEqual((await call('GET', '/api/photos/20', { cookie })).status, 200);

    const res = await call('GET', '/api/annuaire', { cookie });
    assert.strictEqual(res.status, 200);
    const text = res.body.toString();
    const directory = JSON.parse(text);
    assert.deepStrictEqual(directory.teachers, [{ id: '20', name: 'Marie Curie', email: 'marie@ecole.test' }]);
    assert.ok(directory.classmates.length > 0);
    assert.strictEqual(directory.classmates[0].email, undefined);
    assert.doesNotMatch(text, /camarade@ecole\.test|ges-dl\.kordis\.fr/);
    assert.strictEqual((await call('GET', '/api/annuaire')).status, 401);
});

test('profil : ni INE, ni adresse, ni date de naissance', async () => {
    myges();
    globalThis.fetch = ((inner) => async (url, init) => (String(url).endsWith('/me/profile')
        ? json(200, { result: { firstname: 'Ada', name: 'L', email: 'ada@ecole.test', ine: 'INE-SECRET', address1: 'RUE-SECRETE', birthday: 946684800000, emergency_contact: { name: 'URGENCE-SECRET' } } })
        : inner(url, init)))(globalThis.fetch);
    const cookie = await signIn();
    const res = await call('GET', '/api/profil', { cookie });
    const text = res.body.toString();
    assert.strictEqual(JSON.parse(text).email, 'ada@ecole.test');
    assert.doesNotMatch(text, /SECRET|946684800000/);
});

test('agenda : export .ics en pièce jointe, en une seule lecture de MyGES', async () => {
    const start = Date.now() + 3_600_000;
    const calls = myges();
    const inner = globalThis.fetch;
    globalThis.fetch = async (url, init) => (String(url).includes('/me/agenda')
        ? (calls.push(String(url)), json(200, { result: [{ reservation_id: 1, name: 'T1 - Réseaux', start_date: start, end_date: start + 3_600_000, rooms: [] }] }))
        : inner(url, init));
    const cookie = await signIn();
    const res = await call('GET', '/api/agenda.ics', { cookie });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/calendar/);
    assert.match(res.headers['content-disposition'], /^attachment/);
    assert.match(res.body.toString(), /BEGIN:VEVENT[\s\S]*SUMMARY:Réseaux/);
    assert.strictEqual(calls.filter((u) => u.includes('/me/agenda')).length, 1);
    assert.strictEqual((await call('GET', '/api/agenda.ics')).status, 401);
});
