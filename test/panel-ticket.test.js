// Connexion au panel depuis Discord : /panel dépose un ticket, le panel le retire une fois.
process.env.TZ = 'Europe/Paris'; // comme src/panel/server.ts
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { dist, json } = require('./helpers');

const TICKETS = process.env.PANEL_TICKETS_DIR; // dossier temporaire (helpers.js)
const tickets = dist('utils/panelTicket.js');
const store = dist('core/store.js');
const { encrypt } = dist('crypto.js');
const { createPanel } = dist('panel/app.js');
const panel = dist('commands/panel.js').default;
const logout = dist('commands/logout.js').default;

const quiet = (t) => {
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', () => {});
};
const token = (access = 'jeton') => ({ token_type: 'bearer', access_token: access, expires_at: Date.now() + 3_600_000 });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tickets-'));

test('ticket : une seule fois, dix minutes au plus, illisible sans son secret', async () => {
    const dir = tmp();
    const now = Date.now();
    const secret = tickets.createTicket(dir, 'u1', token(), 'a.lovelace', now);
    assert.match(secret, tickets.TICKET_SECRET);
    const [name] = fs.readdirSync(dir);
    const raw = fs.readFileSync(path.join(dir, name), 'utf-8');
    for (const clear of ['jeton', 'lovelace', secret]) assert.ok(!raw.includes(clear) && !name.includes(clear), clear);
    assert.strictEqual(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600);

    const taken = await tickets.takeTicket(dir, secret, now + 1000);
    assert.strictEqual(taken.username, 'a.lovelace');
    assert.strictEqual(taken.token.access_token, 'jeton');
    assert.strictEqual(await tickets.takeTicket(dir, secret, now + 1000), null, 'usage unique');
    assert.deepStrictEqual(fs.readdirSync(dir), []);

    const late = tickets.createTicket(dir, 'u1', token(), 'a.lovelace', now);
    assert.strictEqual(await tickets.takeTicket(dir, late, now + tickets.TICKET_TTL_MS + 1), null, 'échu');

    // Échéance repoussée à la main : le ticket ne s'ouvre plus.
    const forged = tickets.createTicket(dir, 'u1', token(), 'a.lovelace', now);
    const [file] = fs.readdirSync(dir);
    const sealed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
    sealed.expiresAt += 86_400_000;
    fs.writeFileSync(path.join(dir, file), JSON.stringify(sealed));
    assert.strictEqual(await tickets.takeTicket(dir, forged, now + tickets.TICKET_TTL_MS + 1), null, 'falsifié');

    const other = tickets.createTicket(dir, 'u1', token(), 'a.lovelace', now);
    for (const bad of ['', '../../saved_data', 'A'.repeat(43), `${other}x`]) assert.strictEqual(await tickets.takeTicket(dir, bad, now), null, bad);

    // Deux demandes simultanées : une seule passe.
    const results = await Promise.all([tickets.takeTicket(dir, other, now), tickets.takeTicket(dir, other, now)]);
    assert.strictEqual(results.filter(Boolean).length, 1);
});

test('ticket : un seul en attente par étudiant, retiré à la demande, les échus balayés', async () => {
    const dir = tmp();
    const now = Date.now();
    const first = tickets.createTicket(dir, 'u2', token(), 'b.b', now);
    const second = tickets.createTicket(dir, 'u2', token(), 'b.b', now);
    assert.strictEqual(await tickets.takeTicket(dir, first, now), null, 'remplacé par le suivant');
    tickets.dropTicket('u2');
    assert.strictEqual(await tickets.takeTicket(dir, second, now), null, 'retiré');

    tickets.createTicket(dir, 'u3', token(), 'c.c', now - tickets.TICKET_TTL_MS - 1);
    fs.writeFileSync(path.join(dir, `connexion-${'0'.repeat(64)}.json`), '{');
    // Dossier mal réglé (celui des abonnements, la racine) : le reste n'est jamais touché.
    const others = ['saved_data.json', `${'a'.repeat(64)}.json`, 'connexion-court.json'];
    for (const name of others) fs.writeFileSync(path.join(dir, name), '{}');
    const fresh = tickets.createTicket(dir, 'u4', token(), 'd.d', now);
    assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => !others.includes(n)).length, 1, 'échus et illisibles balayés');
    for (const name of others) assert.ok(fs.existsSync(path.join(dir, name)), name);
    assert.ok(await tickets.takeTicket(dir, fresh, now));
});

// --- Le panel ---

let port;
let server;
let role = 'student';
test.before(() => new Promise((resolve) => {
    server = createPanel({ trustProxy: false, ticketsDir: TICKETS });
    server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
    });
}));
test.after(() => server.close());

function myges() {
    globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.endsWith('/me')) return json(200, { result: { normalized_role: role, uid: 7 } });
        if (u.includes('/me/profile')) return json(200, { result: { firstname: 'Ada', name: 'Lovelace' } });
        return json(200, { result: [] });
    };
}

function call(method, url, { body, cookie, origin } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const headers = {};
        if (payload !== undefined) Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
        if (cookie) headers.Cookie = cookie;
        if (method === 'POST') headers.Origin = origin ?? `http://127.0.0.1:${port}`;
        const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString();
                let parsed = null;
                try { parsed = JSON.parse(text); } catch { /* page */ }
                resolve({ status: res.statusCode, headers: res.headers, json: parsed });
            });
        });
        req.on('error', reject);
        req.end(payload);
    });
}

test('panel : un ticket ouvre une session sans mot de passe, une fois ; jamais depuis un autre site', async (t) => {
    quiet(t);
    myges();
    const secret = tickets.createTicket(TICKETS, 'p1', token(), 'a.lovelace');

    const foreign = await call('POST', '/api/connexion', { body: { ticket: secret }, origin: 'https://ailleurs.example' });
    assert.notStrictEqual(foreign.status, 200);

    const res = await call('POST', '/api/connexion', { body: { ticket: secret } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(res.json.name, 'Ada Lovelace');
    const setCookie = res.headers['set-cookie'][0];
    assert.match(setCookie, /HttpOnly; Secure; SameSite=Strict/);
    assert.doesNotMatch(setCookie, /Max-Age/, 'session fermée avec le navigateur');
    const cookie = setCookie.split(';')[0];
    assert.strictEqual((await call('GET', '/api/session', { cookie })).status, 200);

    const again = await call('POST', '/api/connexion', { body: { ticket: secret } });
    assert.strictEqual(again.status, 400);
    assert.match(again.json.error, /expiré ou a déjà servi/);
    assert.strictEqual((await call('POST', '/api/connexion', { body: { ticket: 'n\'importe quoi' } })).status, 400);
});

test('panel : un ticket ne fait pas entrer un compte qui n\'est pas étudiant', async (t) => {
    quiet(t);
    myges();
    role = 'teacher';
    try {
        const secret = tickets.createTicket(TICKETS, 'p2', token(), 'prof.x');
        const res = await call('POST', '/api/connexion', { body: { ticket: secret } });
        assert.strictEqual(res.status, 403);
        assert.strictEqual(res.headers['set-cookie'], undefined);
    } finally {
        role = 'student';
    }
});

// --- /panel sur Discord ---

/** Lance /panel ; renvoie la réponse et l'adresse du bouton « Ouvrir le panel ». */
async function runPanel(userId) {
    const replies = [];
    const push = async (r) => replies.push(r);
    await panel.execute({ user: { id: userId }, deferReply: async () => {}, reply: push, editReply: push });
    const reply = replies.at(-1);
    const buttons = reply.components[0].toJSON().components;
    return { reply, buttons, url: buttons.find((b) => b.url)?.url ?? null };
}

test('/panel : connecté au bot, un bouton personnel ouvre le panel déjà connecté ; /logout le retire', async (t) => {
    quiet(t);
    const before = process.env.PANEL_PUBLIC_URL;
    process.env.PANEL_PUBLIC_URL = 'https://panel.example:8443/';
    try {
        const data = store.loadData();
        data.users.d1 = { user: encrypt('a.lovelace'), pass: encrypt('secret') };
        store.saveData(data);
        store.openSession('d1', token('jeton-bot'));

        const first = await runPanel('d1');
        const match = /^https:\/\/panel\.example:8443\/#connexion=([A-Za-z0-9_-]{43})$/.exec(first.url);
        assert.ok(match, first.url);
        assert.deepStrictEqual(first.buttons.map((b) => b.custom_id ?? 'lien'), ['lien', 'feed:lien']);
        assert.doesNotMatch(JSON.stringify(first.reply.embeds), new RegExp(match[1]), 'le secret n\'est que dans le bouton');

        const second = await runPanel('d1');
        const secret = /#connexion=(.+)$/.exec(second.url)[1];
        assert.strictEqual(await tickets.takeTicket(TICKETS, match[1]), null, 'un seul lien en attente');
        const taken = await tickets.takeTicket(TICKETS, secret);
        assert.strictEqual(taken.username, 'a.lovelace');
        assert.strictEqual(taken.token.access_token, 'jeton-bot');

        const third = /#connexion=(.+)$/.exec((await runPanel('d1')).url)[1];
        await logout.execute({ isButton: () => false, user: { id: 'd1', tag: 'd1', displayAvatarURL: () => null }, reply: async () => {} });
        assert.strictEqual(await tickets.takeTicket(TICKETS, third), null, 'coupé par /logout');

        const stranger = await runPanel('inconnu');
        assert.strictEqual(stranger.url, null);
        assert.match(stranger.reply.embeds[0].toJSON().description, /https:\/\/panel\.example:8443/);
    } finally {
        if (before === undefined) delete process.env.PANEL_PUBLIC_URL;
        else process.env.PANEL_PUBLIC_URL = before;
    }
});
