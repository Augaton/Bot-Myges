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

// Projet d'une année passée qui, s'il était de l'année en cours, serait modifiable :
// choix libre, étape à venir, une équipe avec de la place, étudiant sans groupe.
const pastProject = {
    project_id: 501, name: 'Projet passé', course_name: 'Web', rc_id: 77, project_type_group: 'Libre', project_max_student_group: 3,
    steps: [{ psp_id: 1, psp_limit_date: Date.now() + 5 * 86_400_000, psp_type: 'Rendu' }, { psp_id: 2, psp_limit_date: null, psp_type: 'Soutenance' }],
    groups: [{ project_group_id: 61, group_name: 'Équipe libre', project_group_students: [{ u_id: 9 }] }],
    project_files: [{ pf_id: 900, pf_title: 'Sujet', pf_file: 'sujet.pdf' }],
};
let writes = [];

function kordisProjects() {
    urls = [];
    writes = [];
    globalThis.fetch = async (url, init = {}) => {
        const u = String(url);
        urls.push(u);
        if (u.includes('oauth')) return redirect('x:/#access_token=t&token_type=bearer&expires_in=3600');
        if ((init.method ?? 'GET') !== 'GET') writes.push(`${init.method} ${u}`);
        if (u.endsWith('/me')) return json(200, { result: { normalized_role: 'student', uid: 7 } });
        if (u.endsWith('/me/years')) return json(200, { result: [past, current] });
        if (u.endsWith(`/me/${past}/projects`)) return json(200, { result: [pastProject] });
        if (u.endsWith('/me/projectFiles/900')) return new Response('%PDF', { headers: { 'content-type': 'application/pdf' } });
        return json(200, { result: [] });
    };
}

test('projets d\'une année passée : liste et détail lus pour cette année, en consultation seulement', async (t) => {
    kordisProjects();
    await signIn(t, 'annees.projets');
    const list = await call('GET', `/api/projets?year=${past}`);
    assert.strictEqual(list.status, 200);
    assert.deepStrictEqual(list.json.map((p) => p.name), ['Projet passé']);
    assert.ok(urls.some((u) => u.endsWith(`/me/${past}/projects`)) && urls.some((u) => u.endsWith(`/me/${past}/practicals`)), urls.join(' '));

    const detail = await call('GET', `/api/projets/501?year=${past}`);
    assert.strictEqual(detail.status, 200);
    assert.strictEqual(detail.json.archived, true);
    assert.strictEqual(detail.json.canJoin, false);
    assert.strictEqual(detail.json.canLeave, false);
    assert.strictEqual((await call('GET', '/api/projets/501')).status, 404, 'absent de l\'année en cours');
});

test('projets d\'une année passée : fichiers téléchargeables avec l\'année, introuvables sans', async (t) => {
    kordisProjects();
    await signIn(t, 'annees.fichiers');
    assert.strictEqual((await call('GET', `/api/projets/501/consignes/900?year=${past}`)).status, 200);
    assert.strictEqual((await call('GET', '/api/projets/501/consignes/900')).status, 404);
});

test('projets d\'une année passée : impossible de changer d\'équipe, aucune écriture envoyée à MyGes', async (t) => {
    kordisProjects();
    await signIn(t, 'annees.equipe');
    for (const path of ['/api/projets/501/equipes/61/rejoindre', `/api/projets/501/equipes/61/rejoindre?year=${past}`]) {
        assert.strictEqual((await call('POST', path, {})).status, 404, path);
    }
    assert.deepStrictEqual(writes, []);
});

test('rentrée : l\'année que MyGes n\'a pas encore ouverte n\'est ni proposée ni utilisée par défaut', async (t) => {
    kordis({ years: () => json(200, { result: [past - 1, past] }) }); // l'année du calendrier manque
    await signIn(t, 'annees.rentree');
    const years = await call('GET', '/api/annees');
    assert.deepStrictEqual(years.json, { current: String(past), years: [String(past), String(past - 1)] });

    urls = [];
    const notes = await call('GET', '/api/notes');
    assert.match(JSON.stringify(notes.json), /Ancienne matière/);
    assert.ok(urls.some((u) => u.endsWith(`/me/${past}/grades`)) && !urls.some((u) => u.endsWith(`/me/${current}/grades`)), urls.join(' '));
    assert.strictEqual((await call('GET', `/api/notes?year=${current}`)).status, 404);
});

test('accueil : l\'année du calendrier est lue sans attendre ; à la rentrée, la bonne année l\'emporte', async (t) => {
    const grades = (u) => urls.filter((x) => /\/me\/\d{4}\/grades$/.test(x) && x === u).length;
    kordis(); // MyGes connaît l'année du calendrier : une seule lecture des notes
    await signIn(t, 'annees.accueil');
    urls = [];
    const home = await call('GET', '/api/home');
    assert.match(JSON.stringify(home.json.semester), /Matière actuelle/);
    assert.strictEqual(urls.filter((u) => /\/grades$/.test(u)).length, 1, urls.join(' '));

    kordis({ years: () => json(200, { result: [past - 1, past] }) }); // rentrée : l'année du calendrier n'est pas ouverte
    await signIn(t, 'annees.accueil.rentree');
    urls = [];
    const lag = await call('GET', '/api/home');
    assert.match(JSON.stringify(lag.json.semester), /Ancienne matière/);
    assert.doesNotMatch(JSON.stringify(lag.json.semester), /Matière actuelle/);
    assert.ok(grades(urls.find((u) => u.endsWith(`/me/${past}/grades`))) === 1, urls.join(' '));
});

test('connexion : la liste des années est lue aussitôt, pour le premier écran', async (t) => {
    kordis();
    t.mock.method(console, 'log', () => {});
    cookie = '';
    urls = [];
    assert.strictEqual((await call('POST', '/api/login', { username: 'annees.prefetch', password: 'x' })).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(urls.some((u) => u.endsWith('/me/years')), urls.join(' '));
});
