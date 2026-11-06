// Panel étudiant : serveur réel sur un port local, MyGes simulé.
process.env.TZ = 'Europe/Paris'; // comme src/panel/server.ts
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { dist, json, redirect } = require('./helpers');

const { createPanel } = dist('panel/app.js');
const views = dist('panel/views.js');
const { readSettings } = dist('panel/settings.js');

const quiet = (t) => {
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', () => {});
};
const accepted = (token = 't') => redirect(`x:/#access_token=${token}&token_type=bearer&expires_in=3600`);

/** MyGes simulé : `routes` associe un motif d'URL à une réponse ; renvoie les appels. */
function myges(routes) {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
        calls.push({ url: String(url), auth: init.headers?.Authorization, method: init.method });
        for (const [pattern, respond] of routes) {
            if (String(url).includes(pattern)) return typeof respond === 'function' ? respond(String(url), init) : respond;
        }
        if (String(url).endsWith('/me')) return json(200, { result: { normalized_role: 'student', uid: 7 } });
        return json(200, { result: [] });
    };
    return calls;
}

let port;
let server;
const start = () => new Promise((resolve) => {
    server = createPanel({ trustProxy: false });
    server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
    });
});
test.before(start);
test.after(() => server.close());

/** Requête HTTP brute (fetch étant simulé) ; `cookie` rejoue la session. */
function call(method, url, { body, cookie, origin, type = 'application/json', raw } = {}) {
    return new Promise((resolve, reject) => {
        const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
        const headers = {};
        if (payload !== undefined) Object.assign(headers, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(payload) });
        if (cookie) headers.Cookie = cookie;
        const host = `127.0.0.1:${port}`;
        if (method === 'POST') headers.Origin = origin ?? `http://${host}`;
        if (origin === null) delete headers.Origin;
        const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString();
                let parsed = null;
                try { parsed = JSON.parse(text); } catch { /* fichier ou page */ }
                resolve({ status: res.statusCode, headers: res.headers, text, json: parsed });
            });
        });
        req.on('error', reject);
        req.end(payload);
    });
}

const cookieOf = (res) => res.headers['set-cookie']?.[0].split(';')[0];

async function signIn(username, routes = []) {
    myges([['oauth', () => accepted(username)], ['/me/profile', json(200, { result: { firstname: 'Ada', name: 'Lovelace' } })], ...routes]);
    const res = await call('POST', '/api/login', { body: { username, password: 'secret' } });
    assert.strictEqual(res.status, 200, res.text);
    return cookieOf(res);
}

test('isolation : le panel ne charge ni Discord, ni le canvas, ni les secrets du bot', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-env-'));
    const envFile = path.join(dir, '.env');
    fs.writeFileSync(envFile, 'DISCORD_TOKEN=secret-bot\nENCRYPTION_KEY=secret-cle\nPANEL_PORT=4321\nPANEL_TRUST_PROXY=1\n');
    const script = `
        const {readSettings}=require(${JSON.stringify(path.join(__dirname, '..', 'dist', 'panel', 'settings.js'))});
        require(${JSON.stringify(path.join(__dirname, '..', 'dist', 'panel', 'app.js'))});
        const s=readSettings(${JSON.stringify(envFile)});
        const loaded=Object.keys(require.cache).filter((k)=>/node_modules|canvas/.test(k));
        process.stdout.write(JSON.stringify({s,loaded,token:process.env.DISCORD_TOKEN??null,key:process.env.ENCRYPTION_KEY??null}));`;
    const env = { ...process.env };
    delete env.DISCORD_TOKEN;
    delete env.ENCRYPTION_KEY;
    const out = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf-8' });
    assert.strictEqual(out.status, 0, out.stderr);
    const result = JSON.parse(out.stdout);
    assert.deepStrictEqual(result.loaded, []);
    assert.strictEqual(result.token, null);
    assert.strictEqual(result.key, null);
    assert.deepStrictEqual(result.s, { host: '127.0.0.1', port: 4321, trustProxy: true });
});

test('derrière un proxy, le panel démarre en HTTP sur 0.0.0.0 et le signale', () => {
    const entry = path.join(__dirname, '..', 'dist', 'panel', 'server.js');
    const out = spawnSync(process.execPath, [entry], { env: { ...process.env, PANEL_HOST: '0.0.0.0', PANEL_PORT: '0', PANEL_TRUST_PROXY: '1' }, encoding: 'utf-8', timeout: 4_000 });
    assert.notStrictEqual(out.status, 78);
    assert.match(out.stdout, /doit rester privé/);
});

test('adresses privées : seul un proxy local ou du réseau privé est cru', () => {
    const { isPrivateAddress } = dist('panel/app.js');
    for (const ip of ['127.0.0.1', '::1', '::ffff:172.18.0.1', '172.18.0.1', '10.0.0.2', '192.168.1.1', 'fd00::1']) assert.strictEqual(isPrivateAddress(ip), true, ip);
    for (const ip of ['203.0.113.5', '172.32.0.1', '8.8.8.8', '2001:db8::1']) assert.strictEqual(isPrivateAddress(ip), false, ip);
});

test('réglages : écoute locale par défaut', () => {
    assert.strictEqual(readSettings('/inexistant/.env').host, '127.0.0.1');
});

test('connexion : cookie protégé, ni mot de passe ni token renvoyés', async (t) => {
    quiet(t);
    myges([['oauth', accepted('token-kordis')], ['/me/profile', json(200, { result: { firstname: 'Ada', name: 'Lovelace' } })]]);
    const res = await call('POST', '/api/login', { body: { username: 'a.lovelace', password: 'motdepasse' } });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json, { name: 'Ada Lovelace' });
    assert.doesNotMatch(res.text, /token-kordis|motdepasse/);
    const set = res.headers['set-cookie'][0];
    assert.match(set, /^__Host-panel=/);
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(set.includes(flag), flag);
    const session = await call('GET', '/api/session', { cookie: cookieOf(res) });
    assert.deepStrictEqual(session.json, { name: 'Ada Lovelace' });
});

test('seul un compte étudiant entre : un intervenant au bon mot de passe est refusé', async (t) => {
    quiet(t);
    globalThis.fetch = async (url) => {
        if (String(url).includes('oauth')) return accepted();
        return json(200, { result: { role: 'ROLE_G_TEACHER', normalized_role: 'teacher' } });
    };
    const res = await call('POST', '/api/login', { body: { username: 'prof', password: 'x' } });
    assert.strictEqual(res.status, 403);
    assert.match(res.json.error, /étudiants/);
    assert.strictEqual(res.headers['set-cookie'], undefined);
});

test('rôle illisible car MyGes est en panne : pas de session, message de panne', async (t) => {
    quiet(t);
    globalThis.fetch = async (url) => (String(url).includes('oauth') ? accepted() : json(503, {}));
    const res = await call('POST', '/api/login', { body: { username: 'roleko', password: 'x' } });
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.headers['set-cookie'], undefined);
});

test('API : rien sans session, même pas avec un cookie inventé', async () => {
    for (const url of ['/api/session', '/api/home', '/api/agenda', '/api/notes', '/api/absences', '/api/projets', '/api/news', '/api/documents', '/api/documents/42', '/api/documents/42/7', '/api/courses/42/syllabus', '/api/projets/1', '/api/projets/1/depots/2']) {
        assert.strictEqual((await call('GET', url)).status, 401, url);
        assert.strictEqual((await call('GET', url, { cookie: '__Host-panel=invente' })).status, 401, url);
    }
});

test('mauvais mot de passe : message clair, puis limite par identifiant', async (t) => {
    quiet(t);
    const calls = myges([['oauth', () => json(401, {})]]);
    for (let i = 0; i < 5; i++) {
        const res = await call('POST', '/api/login', { body: { username: 'limite', password: 'x' } });
        assert.strictEqual(res.status, 401);
        assert.match(res.json.error, /incorrect/);
    }
    const blocked = await call('POST', '/api/login', { body: { username: 'LIMITE', password: 'x' } });
    assert.strictEqual(blocked.status, 429);
    assert.strictEqual(calls.length, 5);
});

test('identifiant avec « : » ou espace refusé sans interroger MyGes', async () => {
    const calls = myges([]);
    for (const username of ['cible:essai', 'p nom', '']) {
        assert.strictEqual((await call('POST', '/api/login', { body: { username, password: 'x' } })).status, 400, username);
    }
    assert.strictEqual((await call('POST', '/api/login', { body: { username: 'ok' } })).status, 400);
    assert.strictEqual(calls.length, 0);
});

test('MyGes en panne : message distinct, essai non compté', async (t) => {
    quiet(t);
    const calls = myges([['oauth', () => json(503, {})]]);
    for (let i = 0; i < 7; i++) {
        const res = await call('POST', '/api/login', { body: { username: 'panne', password: 'x' } });
        assert.strictEqual(res.status, 503);
        assert.match(res.json.error, /ne répond pas/);
    }
    assert.strictEqual(calls.length, 7);
});

test('un 403 de Kordis n\'est pas annoncé comme un mauvais mot de passe, mais compte', async (t) => {
    quiet(t);
    const calls = myges([['oauth', () => json(403, {})]]);
    for (let i = 0; i < 5; i++) assert.strictEqual((await call('POST', '/api/login', { body: { username: 'waf', password: 'x' } })).status, 503);
    assert.strictEqual((await call('POST', '/api/login', { body: { username: 'waf', password: 'x' } })).status, 429);
    assert.strictEqual(calls.length, 5);
});

test('CSRF : un autre site, ou une requête sans Origin, ne peut ni connecter ni déconnecter', async () => {
    const calls = myges([]);
    assert.strictEqual((await call('POST', '/api/login', { body: { username: 'a', password: 'b' }, origin: 'https://evil.example' })).status, 403);
    assert.strictEqual((await call('POST', '/api/login', { body: { username: 'a', password: 'b' }, origin: null })).status, 403);
    assert.strictEqual((await call('POST', '/api/logout', { origin: 'https://evil.example' })).status, 403);
    assert.strictEqual(calls.length, 0);
});

test('requêtes malformées : type, taille et JSON refusés proprement', async () => {
    assert.strictEqual((await call('POST', '/api/login', { raw: 'username=a', type: 'application/x-www-form-urlencoded' })).status, 415);
    assert.strictEqual((await call('POST', '/api/login', { raw: '{' })).status, 400);
    const tooLarge = await call('POST', '/api/login', { raw: JSON.stringify({ username: 'a', password: 'x'.repeat(5_000) }) });
    assert.strictEqual(tooLarge.status, 413);
    assert.strictEqual((await call('DELETE', '/api/session')).status, 405);
    assert.strictEqual((await call('HEAD', '/api/session')).status, 405);
});

test('HEAD sur une page : 200, comme curl -I', async () => {
    assert.strictEqual((await call('HEAD', '/')).status, 200);
    assert.strictEqual((await call('HEAD', '/style.css')).status, 200);
});

test('fichiers servis : liste fermée, en-têtes stricts', async () => {
    const page = await call('GET', '/');
    assert.strictEqual(page.status, 200);
    assert.match(page.headers['content-security-policy'], /default-src 'none'/);
    assert.match(page.headers['content-security-policy'], /script-src 'self'/);
    assert.doesNotMatch(page.headers['content-security-policy'], /unsafe/);
    assert.strictEqual(page.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(page.headers['x-frame-options'], 'DENY');
    assert.strictEqual(page.headers['referrer-policy'], 'no-referrer');
    assert.match(page.headers['x-robots-tag'], /noindex/);
    for (const url of ['/../.env', '/..%2f..%2f.env', '/saved_data.json', '/.env', '/src/config.ts', '/%2e%2e/%2e%2e/.env']) {
        const res = await call('GET', url);
        assert.strictEqual(res.status, 404, url);
        assert.doesNotMatch(res.text, /DISCORD_TOKEN|ENCRYPTION_KEY/);
    }
});

test('les données d\'un étudiant ne sont pas visibles depuis une autre session', async () => {
    const absences = (url, init) => json(200, { result: [{ course_name: init.headers.Authorization.includes('alice') ? 'Cours Alice' : 'Cours Bob', date: 1000 }] });
    const alice = await signIn('alice', [['/absences', absences]]);
    const bob = await signIn('bob', [['/absences', absences]]);
    assert.match((await call('GET', '/api/absences', { cookie: alice })).text, /Cours Alice/);
    const seen = await call('GET', '/api/absences', { cookie: bob });
    assert.match(seen.text, /Cours Bob/);
    assert.doesNotMatch(seen.text, /Alice/);
});

test('token refusé par MyGes : session fermée, retour à la connexion', async () => {
    const cookie = await signIn('expire', [['/grades', () => json(401, {})]]);
    assert.strictEqual((await call('GET', '/api/notes', { cookie })).status, 401);
    assert.strictEqual((await call('GET', '/api/session', { cookie })).status, 401);
});

test('déconnexion : le cookie ne sert plus', async () => {
    const cookie = await signIn('sortie');
    assert.strictEqual((await call('GET', '/api/session', { cookie })).status, 200);
    const out = await call('POST', '/api/logout', { cookie });
    assert.match(out.headers['set-cookie'][0], /Max-Age=0/);
    assert.strictEqual((await call('GET', '/api/session', { cookie })).status, 401);
});

test('accueil : un bloc en panne n\'empêche pas d\'afficher les autres', async (t) => {
    quiet(t);
    const cookie = await signIn('partiel', [
        ['/grades', () => json(500, {})],
        ['/absences', json(200, { result: [{ course_name: 'Web', date: 1000, justified: false }] })],
    ]);
    const res = await call('GET', '/api/home', { cookie });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.semester, null);
    assert.deepStrictEqual(res.json.absences, { total: 1, unjustified: 1 });
});

test('agenda : semaine demandée, date invalide refusée', async () => {
    let asked;
    const cookie = await signIn('agenda', [['/agenda', (url) => { asked = url; return json(200, { result: [] }); }]]);
    const res = await call('GET', '/api/agenda?week=2026-11-04', { cookie });
    assert.strictEqual(new Date(res.json.start).toISOString().slice(0, 10), '2026-11-01');
    assert.match(asked, /start=\d+&end=\d+/);
    assert.strictEqual((await call('GET', '/api/agenda?week=2026-13-45', { cookie })).status, 400);
});

test('documents : liste, puis téléchargement toujours en pièce jointe', async () => {
    const cookie = await signIn('docs', [
        ['/courses', json(200, { result: [{ rc_id: 42, name: 'T1 - Réseaux', has_documents: true }] })],
        ['/me/42/files/7', () => new Response('<script>alert(1)</script>', { headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="../../cours.pdf"' } })],
        ['/me/42/files', json(200, { result: [{ oc_id: 7, label: 'Cours 1', extension: '.pdf', update_date: 2000 }] })],
    ]);
    const sources = await call('GET', '/api/documents', { cookie });
    assert.deepStrictEqual(sources.json.map((s) => s.id), ['annual', '42']);
    const files = await call('GET', '/api/documents/42', { cookie });
    assert.strictEqual(files.json[0].id, '7');
    const file = await call('GET', '/api/documents/42/7', { cookie });
    assert.strictEqual(file.status, 200);
    assert.strictEqual(file.headers['content-type'], 'application/octet-stream');
    assert.match(file.headers['content-disposition'], /^attachment; filename\*=UTF-8''cours\.pdf$/);
    assert.strictEqual(file.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual((await call('GET', '/api/documents/42/..%2f..%2fprofile', { cookie })).status, 404);
});

test('vues : notes groupées par semestre, sans champ brut de MyGes', () => {
    const [s1, s2] = views.notesView([
        { course: 'T2 - Web', trimester_name: 'Semestre 2', average: 14, ects: '2.0', teacher_last_name: 'Martin' },
        { course: 'T1 - Anglais', trimester_name: 'Semestre 1', grades: [12, 15], rc_id: 9, username: 'x' },
    ]);
    assert.strictEqual(s1.name, 'Semestre 1');
    assert.strictEqual(s2.average, 14);
    assert.deepStrictEqual(s1.subjects[0].notes, [12, 15]);
    assert.strictEqual(s1.average, null);
    assert.strictEqual(s1.subjects[0].rcId, '9');
    assert.strictEqual(s1.subjects[0].username, undefined);
    assert.deepStrictEqual(views.notesView(null), []);
});

test('projets : le dépôt d\'un autre groupe et un projet étranger ne se téléchargent pas', async () => {
    const project = {
        project_id: 1, name: 'P', steps: [{ psp_id: 1, psp_limit_date: 1000, files: [{ psf_id: 11, pgr_id: 5, psf_name: 'mien' }, { psf_id: 12, pgr_id: 6, psf_name: 'autre' }] }],
        project_files: [{ pf_id: 21, pf_file: 'c.pdf' }],
        groups: [{ project_group_id: 5, project_group_students: [{ u_id: 7 }] }, { project_group_id: 6, project_group_students: [{ u_id: 8 }] }],
    };
    const cookie = await signIn('depots', [
        ['/projects', json(200, { result: [project] })],
        ['/practicals', json(200, { result: [] })],
        ['/me/projectStepFiles/11', () => new Response('mien')],
        ['/me/projectStepFiles/12', () => new Response('autre')],
        ['/me/projectFiles/21', () => new Response('consigne')],
    ]);
    assert.strictEqual((await call('GET', '/api/projets/1/depots/11', { cookie })).text, 'mien');
    assert.strictEqual((await call('GET', '/api/projets/1/consignes/21', { cookie })).text, 'consigne');
    assert.strictEqual((await call('GET', '/api/projets/1/depots/12', { cookie })).status, 404);
    assert.strictEqual((await call('GET', '/api/projets/1/consignes/99', { cookie })).status, 404);
    assert.strictEqual((await call('GET', '/api/projets/2', { cookie })).status, 404);
    assert.strictEqual((await call('GET', '/api/projets/1/autre/21', { cookie })).status, 404);
});

test('équipes : le serveur revérifie tout avant d\'écrire sur MyGES', async (t) => {
    quiet(t);
    const step = { psp_id: 1, psp_limit_date: Date.now() + 86_400_000, psp_type: 'Rendu' };
    const group = (id, ...uids) => ({ project_group_id: id, group_name: `G${id}`, project_group_students: uids.map((u_id) => ({ u_id })) });
    const free = { project_id: 1, rc_id: 9, project_type_group: 'Libre', project_max_student_group: 2, steps: [step], groups: [group(5, 8), group(6, 8, 9)] };
    const imposed = { ...free, project_id: 2, project_type_group: 'Imposé' };
    const finished = { ...free, project_id: 3, steps: [{ ...step, psp_limit_date: 1000 }] };
    const mine = { ...free, project_id: 4, groups: [group(5, 7), group(6)] };
    const routes = [['/projects', json(200, { result: [] })], ['/practicals', json(200, { result: [] })]];
    const cookie = await signIn('equipes', routes);
    const calls = myges([['/groups/', () => json(200, { result: {} })], ['/projects', () => json(200, { result: [free, imposed, finished, mine] })], ['/practicals', () => json(200, { result: [] })]]);
    const writes = () => calls.filter((c) => c.method && c.method !== 'GET');
    const team = (project, id, action) => call('POST', `/api/projets/${project}/equipes/${id}/${action}`, { body: {}, cookie });

    assert.strictEqual((await team(1, 6, 'rejoindre')).status, 409); // complète
    assert.strictEqual((await team(2, 5, 'rejoindre')).status, 409); // groupes imposés
    assert.strictEqual((await team(3, 5, 'rejoindre')).status, 409); // projet terminé
    assert.strictEqual((await team(4, 6, 'rejoindre')).status, 409); // déjà dans une équipe
    assert.strictEqual((await team(1, 5, 'quitter')).status, 409); // pas la sienne
    assert.strictEqual((await team(1, 99, 'rejoindre')).status, 404);
    assert.strictEqual((await team(8, 5, 'rejoindre')).status, 404);
    assert.strictEqual(writes().length, 0, 'aucune écriture envoyée');

    const other = await call('POST', '/api/projets/1/equipes/5/rejoindre', { body: {}, cookie, origin: 'https://evil.example' });
    assert.strictEqual(other.status, 403);
    assert.strictEqual((await call('POST', '/api/projets/1/equipes/5/rejoindre', { body: {} })).status, 401);

    assert.strictEqual((await team(1, 5, 'rejoindre')).status, 200);
    assert.deepStrictEqual(writes().map((c) => [c.method, new URL(c.url).pathname]), [['POST', '/me/courses/9/projects/1/groups/5']]);
    assert.strictEqual((await team(4, 5, 'quitter')).status, 200);
    assert.strictEqual(writes().at(-1).method, 'DELETE');
});

test('équipes : un refus de MyGES est dit clairement et n\'est pas rejoué', async (t) => {
    quiet(t);
    const project = { project_id: 1, rc_id: 9, project_type_group: 'Libre', steps: [{ psp_id: 1, psp_limit_date: Date.now() + 86_400_000 }], groups: [{ project_group_id: 5, group_name: 'G', project_group_students: [] }] };
    const cookie = await signIn('refus', []);
    let writes = 0;
    myges([['/groups/', () => { writes++; return json(400, {}); }], ['/projects', () => json(200, { result: [project] })], ['/practicals', () => json(200, { result: [] })]]);
    const res = await call('POST', '/api/projets/1/equipes/5/rejoindre', { body: {}, cookie });
    assert.strictEqual(res.status, 409);
    assert.match(res.json.error, /refusé/);
    assert.strictEqual(writes, 1);
});

test('projet : ni commentaire interne, ni autre groupe, ni brouillon', () => {
    const raw = [
        {
            project_id: 1, name: 'P', steps: [], project_group_logs: [{ pgr_id: 6, pgl_describe: 'étranger' }],
            groups: [
                { project_group_id: 5, group_name: 'A', teacher_comment: 'visible', teacher_intern_comment: 'SECRET', project_group_students: [{ u_id: 7, firstname: 'Ada', name: 'L', classe: '3A', option: 'x' }] },
                { project_group_id: 6, group_name: 'B', project_group_students: [{ u_id: 8, firstname: 'Bob', name: 'M' }] },
            ],
        },
        { project_id: 2, name: 'Brouillon', is_draft: true, steps: [] },
    ];
    const detail = views.projectDetail(raw, '1', 7);
    const text = JSON.stringify(detail);
    assert.strictEqual(detail.group.teacherComment, 'visible');
    assert.deepStrictEqual(detail.group.members, ['Ada L']);
    assert.strictEqual(detail.groupCount, 2);
    assert.deepStrictEqual(detail.activity, []);
    for (const hidden of ['SECRET', 'étranger', '3A']) assert.ok(!text.includes(hidden), hidden);
    assert.deepStrictEqual(detail.teams.map((t) => [t.name, t.members, t.mine]), [['A', ['Ada L'], true], ['B', ['Bob M'], false]]);
    assert.strictEqual(views.projectDetail(raw, '2', 7), null);
    assert.strictEqual(views.projectDetail(raw, '1', 9).group, null);
    assert.strictEqual(views.projectDetail(raw, '1', null).group, null);
    assert.deepStrictEqual(views.projectsView(raw, 7).map((p) => p.name), ['P']);
});

test('vues : événements à venir seulement, du plus proche au plus lointain', () => {
    const later = Date.now() + 2_000_000;
    const soon = Date.now() + 1_000_000;
    assert.deepStrictEqual(views.eventsView([{ event_title: 'B', event_date: later }, { event_title: 'A', event_date: soon }, { event_title: 'Passé', event_date: 1000 }, null]).map((e) => e.title), ['A', 'B']);
    assert.deepStrictEqual(views.eventsView(null), []);
});

test('vues : un examen reste identifiable dans l\'agenda', () => {
    const [c] = views.coursesView([{ reservation_id: 1, name: 'T1 - Web', type: 'Examen', start_date: 1000, end_date: 2000 }]);
    assert.strictEqual(c.type, 'Examen');
});

test('vues : détail d\'un cours et syllabus, sans champ superflu', () => {
    const [c] = views.coursesView([{ reservation_id: 1, name: 'T1 - Web', start_date: 1000, end_date: 2000, comment: null, rooms: [{ name: 'A', floor: '1er', campus: 'NATION1', latitude: '48' }], discipline: { rc_id: 9, trimester: 'S1', nb_students: 20 } }]);
    assert.deepStrictEqual(c.rooms, [{ name: 'A', floor: '1er', campus: 'Nation 1' }]);
    assert.strictEqual(c.rcId, '9');
    assert.strictEqual(c.comment, '');

    const s = views.syllabusView([{ control_types: [{ evaluation_label: 'Examen' }, {}], prerequisite: '<p>Aucun</p>', resp_email: 'x@y', seance_details: [{ content: 'Intro' }, { content: null }] }]);
    assert.deepStrictEqual(s.evaluation, ['Examen']);
    assert.strictEqual(s.prerequisite, 'Aucun');
    assert.deepStrictEqual(s.sessions, ['Intro']);
    assert.strictEqual(s.resp_email, undefined);
    assert.strictEqual(views.syllabusView(null), null);
    assert.strictEqual(views.syllabusView([]), null);
});

test('vues : données inattendues ignorées sans planter', () => {
    assert.deepStrictEqual(views.coursesView([{ name: 'sans date' }, null]), []);
    assert.deepStrictEqual(views.absencesView('x'), { total: 0, unjustified: 0, lates: 0, items: [], subjects: [] });
    assert.deepStrictEqual(views.projectsView(undefined), []);
    assert.deepStrictEqual(views.newsView({ content: null }), []);
});

test('vues : le HTML des actualités devient du texte', () => {
    const [n] = views.newsView({ content: [{ title: '<b>Rentr&eacute;e</b>', html: '<script>x</script><p>Bonjour</p>', date: 1000 }] });
    assert.strictEqual(n.title, 'Rentrée');
    assert.doesNotMatch(n.body, /[<>]/);
});

test('présentation : une page courte reste en haut de l\'écran', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'assets', 'panel', 'style.css'), 'utf-8');
    assert.match(css.match(/^main \{[^}]*\}/m)[0], /align-content: start/);
});

test('interface : jamais de HTML construit à partir d\'une chaîne, ni de script en ligne', () => {
    const dir = path.join(__dirname, '..', 'assets', 'panel');
    const app = fs.readFileSync(path.join(dir, 'app.js'), 'utf-8');
    assert.doesNotMatch(app, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
    const page = fs.readFileSync(path.join(dir, 'index.html'), 'utf-8');
    assert.doesNotMatch(page, /<script(?![^>]*\bsrc=)|\son[a-z]+=|style=/);
    assert.match(fs.readFileSync(path.join(dir, 'app.js'), 'utf-8'), /Service non officiel/);
});

// --- HTTPS intégré ---
const { execFileSync } = require('node:child_process');
const https = require('node:https');
const { reloadTls } = dist('panel/app.js');

/** Certificat de test, créé à la volée : aucune clé privée dans le dépôt. */
function certificate(dir, name) {
    const key = path.join(dir, `${name}.key`);
    const cert = path.join(dir, `${name}.pem`);
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', `/CN=${name}`], { stdio: 'ignore' });
    return { key, cert };
}

const hasOpenssl = spawnSync('openssl', ['version']).status === 0;

test('HTTPS intégré : la page et la connexion passent, le certificat se recharge sans redémarrer', { skip: !hasOpenssl }, async (t) => {
    quiet(t);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-tls-'));
    const tls = certificate(dir, 'premier');
    const secure = createPanel({ trustProxy: false, tls });
    await new Promise((resolve) => secure.listen(0, '127.0.0.1', resolve));
    const securePort = secure.address().port;
    const request = (method, url, body) => new Promise((resolve, reject) => {
        const payload = body && JSON.stringify(body);
        const req = https.request({
            host: '127.0.0.1', port: securePort, method, path: url, rejectUnauthorized: false, agent: false,
            headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Origin: `https://127.0.0.1:${securePort}` } : {},
        }, (res) => {
            const issuer = res.socket.getPeerCertificate().subject?.CN;
            res.resume();
            res.on('end', () => resolve({ status: res.statusCode, issuer, cookie: res.headers['set-cookie']?.[0] }));
        });
        req.on('error', reject);
        req.end(payload);
    });

    assert.strictEqual((await request('GET', '/')).status, 200);
    myges([['oauth', accepted()]]);
    const login = await request('POST', '/api/login', { username: 'tls', password: 'x' });
    assert.strictEqual(login.status, 200);
    assert.match(login.cookie, /Secure/);
    assert.strictEqual((await request('GET', '/')).issuer, 'premier');

    const renewed = certificate(dir, 'renouvele');
    fs.copyFileSync(renewed.cert, tls.cert);
    fs.copyFileSync(renewed.key, tls.key);
    reloadTls(secure, tls);
    assert.strictEqual((await request('GET', '/')).issuer, 'renouvele');
    await new Promise((resolve) => secure.close(resolve));
});

test('sans HTTPS, le panel refuse de démarrer sur une adresse joignable depuis le réseau', () => {
    const entry = path.join(__dirname, '..', 'dist', 'panel', 'server.js');
    // Le refus se termine seul : un délai court le ferait échouer sur une machine chargée.
    const run = (PANEL_HOST, timeout) => spawnSync(process.execPath, [entry], { env: { ...process.env, PANEL_HOST, PANEL_PORT: '0' }, encoding: 'utf-8', timeout });
    const open = run('0.0.0.0', 30_000);
    assert.strictEqual(open.status, 78);
    assert.match(open.stderr, /HTTPS/);
    assert.notStrictEqual(run('127.0.0.1', 1_500).status, 78);
});
