// Abonnement d'agenda : préparé par le bot, servi par le panel, illisible sans le lien.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { dist, json, redirect } = require('./helpers');

// Avant tout chargement du bot : le dossier est lu une fois, au démarrage.
const FEEDS = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-feeds-'));
process.env.PANEL_FEEDS_DIR = FEEDS;

const store = dist('core/store.js');
const mygesData = dist('core/mygesData.js');
const { encrypt } = dist('crypto.js');
const { createPanel } = dist('panel/app.js');
const { openFeed, sealFeed, newFeedSecret, feedId } = dist('utils/feedSeal.js');
const { runFeedRefresh } = dist('tasks/agendaFeeds.js');
const abonnement = dist('commands/abonnement.js').default;
const logout = dist('commands/logout.js').default;

let courseName = 'Réseaux avancés';
function kordis() {
    globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes('oauth')) return redirect('x:/#access_token=t&token_type=bearer&expires_in=86400');
        if (u.includes('/agenda')) {
            const start = Date.now() + 2 * 86_400_000;
            return json(200, { result: [{ reservation_id: 1, name: courseName, start_date: start, end_date: start + 7_200_000, rooms: [] }] });
        }
        return json(200, { result: [] });
    };
}

function account(id) {
    const data = store.loadData();
    data.users[id] = { user: encrypt(`${id}.nom`), pass: encrypt('secret') };
    store.saveData(data);
    store.openSession(id, { token_type: 'bearer', access_token: 't' });
}

/** Lance /abonnement ; renvoie le lien affiché, ou le texte de la réponse. */
async function run(userId, action = null) {
    const replies = [];
    await abonnement.execute({
        user: { id: userId },
        options: { getString: (name) => (name === 'action' ? action : null) },
        deferReply: async () => {},
        editReply: async (reply) => replies.push(reply),
    });
    const reply = replies.at(-1);
    if (typeof reply === 'string') return { text: reply };
    const link = reply.embeds[0].data.description.match(/https:\/\/\S+\/agenda\/([A-Za-z0-9_-]{43})\.ics/);
    return { link: link[0], secret: link[1], text: reply.embeds[0].data.description };
}

let server;
let port;
test.before(() => new Promise((resolve) => {
    server = createPanel({ trustProxy: false, feedsDir: FEEDS });
    server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
    });
}));
test.after(() => server.close());

function get(urlPath) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: urlPath, agent: false }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
        }).on('error', reject);
    });
}
const feed = (secret) => get(`/agenda/${secret}.ics`);
const quiet = (t) => {
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', () => {});
};

test('chiffrement : lisible avec le bon secret seulement, et pas une fois modifié', () => {
    const secret = newFeedSecret();
    const sealed = sealFeed(secret, 'BEGIN:VCALENDAR');
    assert.strictEqual(openFeed(secret, sealed), 'BEGIN:VCALENDAR');
    assert.throws(() => openFeed(newFeedSecret(), sealed));
    assert.throws(() => openFeed(secret, { ...sealed, content: (sealed.content[0] === '0' ? '1' : '0') + sealed.content.slice(1) }));
    assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
});

test('/abonnement : lien créé, fichier sans rien de lisible, calendrier servi par le panel', async (t) => {
    quiet(t);
    kordis();
    process.env.PANEL_PUBLIC_URL = 'https://exemple.test:8443/';
    account('abo');
    const { link, secret } = await run('abo');
    assert.strictEqual(link, `https://exemple.test:8443/agenda/${secret}.ics`); // sans double barre

    const file = path.join(FEEDS, `${crypto.createHash('sha256').update(secret).digest('hex')}.json`);
    const raw = fs.readFileSync(file, 'utf-8');
    for (const hidden of ['Réseaux avancés', secret, 'VCALENDAR']) assert.ok(!raw.includes(hidden), hidden);
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);

    const res = await feed(secret);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/calendar/);
    assert.match(res.text, /BEGIN:VCALENDAR/);
    assert.match(res.text, /Réseaux avancés/);
    assert.strictEqual(res.headers['set-cookie'], undefined);

    // Même lien à la demande suivante.
    assert.strictEqual((await run('abo')).secret, secret);
});

test('lien inconnu, mal formé ou fichier modifié : 404, rien à deviner', async (t) => {
    quiet(t);
    kordis();
    const { secret } = await run('abo');
    assert.strictEqual((await feed(newFeedSecret())).status, 404);
    assert.strictEqual((await get('/agenda/court.ics')).status, 404);
    assert.strictEqual((await get(`/agenda/${secret}.ics/../x`)).status, 404);

    const file = path.join(FEEDS, `${feedId(secret)}.json`);
    const original = fs.readFileSync(file, 'utf-8');
    const sealed = JSON.parse(original);
    sealed.content = (sealed.content[0] === '0' ? '1' : '0') + sealed.content.slice(1);
    fs.writeFileSync(file, JSON.stringify(sealed));
    assert.strictEqual((await feed(secret)).status, 404);
    fs.writeFileSync(file, original);
    assert.strictEqual((await feed(secret)).status, 200);
});

test('nouveau lien : l\'ancien cesse de fonctionner ; la mise à jour suit l\'agenda ; les fichiers orphelins disparaissent', async (t) => {
    quiet(t);
    kordis();
    const old = (await run('abo')).secret;
    const fresh = (await run('abo', 'nouveau')).secret;
    assert.notStrictEqual(fresh, old);
    assert.strictEqual((await feed(old)).status, 404);
    assert.strictEqual((await feed(fresh)).status, 200);

    courseName = 'Cours déplacé';
    mygesData.forgetUser('abo');
    fs.writeFileSync(path.join(FEEDS, 'orphelin.json'), '{}');
    await runFeedRefresh();
    assert.match((await feed(fresh)).text, /Cours déplacé/);
    assert.ok(!fs.existsSync(path.join(FEEDS, 'orphelin.json')));
    courseName = 'Réseaux avancés';
});

test('supprimer, puis /logout : le lien cesse de fonctionner, rien ne reste', async (t) => {
    quiet(t);
    kordis();
    const { secret } = await run('abo');
    assert.match((await run('abo', 'supprimer')).text, /supprimé/);
    assert.strictEqual((await feed(secret)).status, 404);
    assert.strictEqual(store.loadData().feeds?.abo, undefined);
    assert.match((await run('abo', 'supprimer')).text, /pas d'abonnement/);

    const again = (await run('abo')).secret;
    await logout.execute({ user: { id: 'abo', tag: 'abo', displayAvatarURL: () => null }, reply: async () => {}, editReply: async () => {}, deferReply: async () => {} });
    assert.strictEqual((await feed(again)).status, 404);
    assert.strictEqual(store.loadData().feeds?.abo, undefined);
    assert.deepStrictEqual(fs.readdirSync(FEEDS), []);
});

test('sans adresse publique du panel : aucun lien créé', async (t) => {
    quiet(t);
    kordis();
    account('sans-adresse');
    const saved = process.env.PANEL_PUBLIC_URL;
    delete process.env.PANEL_PUBLIC_URL;
    try {
        assert.match((await run('sans-adresse')).text, /PANEL_PUBLIC_URL/);
        assert.strictEqual(store.loadData().feeds?.['sans-adresse'], undefined);
    } finally {
        process.env.PANEL_PUBLIC_URL = saved;
    }
});

/** MyGes simulé dont la lecture d'agenda attend un feu vert : de quoi glisser une action pendant un passage. */
function slowAgenda() {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes('oauth')) return redirect('x:/#access_token=t&token_type=bearer&expires_in=86400');
        if (u.includes('/agenda')) {
            await gate;
            const start = Date.now() + 2 * 86_400_000;
            return json(200, { result: [{ reservation_id: 1, name: courseName, start_date: start, end_date: start + 7_200_000, rooms: [] }] });
        }
        return json(200, { result: [] });
    };
    return release;
}

test('passage du bot en cours : un /logout ne laisse pas l\'ancien lien revivre, un lien créé entre-temps garde son fichier', async (t) => {
    quiet(t);
    kordis();
    account('course-a');
    account('course-b');
    const old = (await run('course-a')).secret;

    mygesData.forgetUser('course-a');
    const release = slowAgenda();
    const pass = runFeedRefresh(); // s'arrête sur la lecture d'agenda de course-a
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Pendant ce temps : course-a se déconnecte, course-b crée son lien.
    await logout.execute({ user: { id: 'course-a', tag: 'a', displayAvatarURL: () => null }, reply: async () => {}, editReply: async () => {}, deferReply: async () => {} });
    kordis();
    const fresh = (await run('course-b')).secret;

    slowAgenda();
    release();
    await pass;
    kordis();
    assert.strictEqual((await feed(old)).status, 404, 'l\'ancien lien ne revit pas');
    assert.strictEqual((await feed(fresh)).status, 200, 'le lien créé pendant le passage fonctionne');
});

test('préparation en cours : un lien supprimé entre-temps n\'est pas recréé', async (t) => {
    quiet(t);
    const { createFeed, refreshFeed, removeFeed } = dist('tasks/agendaFeeds.js');
    account('course-c');
    const secret = createFeed('course-c');
    mygesData.forgetUser('course-c');
    const release = slowAgenda();
    const preparing = refreshFeed('course-c', secret, { token_type: 'bearer', access_token: 't' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    removeFeed('course-c'); // /logout ou « Supprimer » pendant la lecture de l'agenda
    release();
    await preparing;
    assert.ok(!fs.existsSync(path.join(FEEDS, `${feedId(secret)}.json`)), 'aucun fichier recréé');
    kordis();
});

// En dernier : il épuise volontairement le quota de lectures de ce réseau.
test('lectures limitées par réseau : un balayage de liens est freiné', async (t) => {
    quiet(t);
    let last = 0;
    for (let i = 0; i < 70; i++) last = (await feed(newFeedSecret())).status;
    assert.strictEqual(last, 429);
});

