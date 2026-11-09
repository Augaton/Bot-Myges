// Interface du panel : le vrai app.js, sur un DOM minimal, contre le vrai serveur.
// Vérifie le parcours et chaque écran ; le rendu CSS, lui, demande un navigateur.
process.env.TZ = 'Europe/Paris';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { dist, json, redirect } = require('./helpers');

const { createPanel } = dist('panel/app.js');
const source = fs.readFileSync(path.join(__dirname, '..', 'assets', 'panel', 'app.js'), 'utf-8');

class El {
    constructor(tag) {
        Object.assign(this, { tag, attrs: {}, kids: [], parent: null, listeners: {}, className: '', value: '', disabled: false, hidden: false, isConnected: true, style: { vars: {}, setProperty(k, v) { this.vars[k] = v; } } });
    }
    setAttribute(k, v) {
        this.attrs[k] = String(v);
        if (k === 'selected') this.selected = true;
    }
    removeAttribute(k) { delete this.attrs[k]; }
    getAttribute(k) { return this.attrs[k] ?? null; }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    adopt(items) { return items.map((c) => (typeof c === 'string' ? c : Object.assign(c, { parent: this }))); }
    append(...items) { this.kids.push(...this.adopt(items)); }
    prepend(...items) { this.kids.unshift(...this.adopt(items)); }
    replaceChildren(...items) { this.kids = this.adopt(items); }
    remove() { this.parent?.kids.splice(this.parent.kids.indexOf(this), 1); }
    focus() {}
    showModal() {}
    close() { return this.fire('close'); }
    click() { return this.fire('click'); }
    fire(type, event = {}) { return Promise.all((this.listeners[type] ?? []).map((fn) => fn({ target: this, preventDefault() {}, ...event }))); }
    get textContent() { return this.kids.map((c) => (typeof c === 'string' ? c : c.textContent)).join(' '); }
    set textContent(text) { this.kids = [String(text)]; }
    all(match, found = []) {
        for (const c of this.kids) {
            if (typeof c === 'string') continue;
            if (match(c)) found.push(c);
            c.all(match, found);
        }
        return found;
    }
    querySelector(selector) { return this.all((e) => selector === '[role="alert"]' && e.attrs.role === 'alert')[0] ?? null; }
}

let port;
let server;
test.before(() => new Promise((resolve) => {
    const sessionsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'panel-ui-')), 'panel_sessions.json');
    server = createPanel({ trustProxy: false, sessionsFile });
    server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
    });
}));
test.after(() => server.close());

/** Navigateur minimal : cookie gardé d'une requête à l'autre, comme le ferait le vrai. */
function browser() {
    let cookie = '';
    let rawCookie = '';
    const blobs = [];
    const requests = [];
    let failure = null;
    const send = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
        requests.push(url);
        if (failure) {
            const { status, html } = failure;
            failure = null;
            resolve(new Response(html, { status, headers: { 'content-type': 'text/html' } }));
            return;
        }
        const all = { ...headers, ...(cookie ? { Cookie: cookie } : {}), ...(method === 'POST' ? { Origin: `http://127.0.0.1:${port}` } : {}) };
        const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: all }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const set = res.headers['set-cookie']?.[0];
                if (set) {
                    rawCookie = set;
                    cookie = /Max-Age=0/.test(set) ? '' : set.split(';')[0];
                }
                const h = new Headers();
                for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') h.set(k, v);
                resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: h }));
            });
        });
        req.on('error', reject);
        req.end(body);
    });

    const root = new El('div');
    const windowListeners = {};
    const location = { hash: '', pathname: '/' };
    const context = vm.createContext({
        document: { getElementById: () => root, createElement: (tag) => new El(tag), title: '' },
        window: { addEventListener: (type, fn) => { windowListeners[type] = fn; }, scrollTo() {}, scrollY: 0 },
        location,
        history: { replaceState() { location.hash = ''; } },
        fetch: send,
        URL: { createObjectURL: (blob) => { blobs.push(blob); return 'blob:x'; }, revokeObjectURL() {} },
        setTimeout: () => 0,
        clearTimeout() {},
        encodeURIComponent,
    });
    vm.runInContext(source, context);

    const settle = async () => {
        for (let i = 0; i < 12; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    };
    return {
        root,
        blobs,
        requests,
        windowListeners,
        failNext: (status, html) => { failure = { status, html }; },
        lastCookie: () => rawCookie,
        settle,
        text: () => root.textContent,
        byId: (id) => root.all((e) => e.attrs.id === id)[0],
        button: (label) => root.all((e) => e.tag === 'button' && e.textContent.includes(label))[0],
        alerts: () => root.all((e) => e.attrs.role === 'alert' && !e.hidden).map((e) => e.textContent).filter(Boolean),
        async go(hash) {
            location.hash = `#${hash}`;
            windowListeners.hashchange();
            await settle();
        },
        async signIn(username, password) {
            this.byId('username').value = username;
            this.byId('password').value = password;
            await root.all((e) => e.tag === 'form')[0].fire('submit');
            await settle();
        },
    };
}

const now = Date.now();
const H = 3_600_000;
const course = (id, startIn, name) => ({
    reservation_id: id, name, start_date: now + startIn * H, end_date: now + (startIn + 2) * H, teacher: 'M. Bernard', type: 'Cours', modality: 'Présentiel',
    rooms: [{ name: 'Salle 12', floor: '2ème étage', campus: 'NATION1' }],
    discipline: { rc_id: 42, trimester: 'Semestre 1', student_group_name: 'Groupe A', nb_students: 24 },
});

function mygesMock(overrides = []) {
    const routes = [
        ...overrides,
        ['oauth', (_, init) => (Buffer.from(init.headers.Authorization.slice(6), 'base64').toString().endsWith(':bon')
            ? redirect('x:/#access_token=t&token_type=bearer&expires_in=3600')
            : json(401, {}))],
        ['/me/profile', () => json(200, { result: { firstname: 'Inès', name: 'Morel' } })],
        ['/grades', () => json(200, { result: [
            { course: 'T1 - Réseaux', trimester_name: 'Semestre 1', average: 13.25, ects: '4.0', grades: [12, 14.5], exam: 13, teacher_last_name: 'Bernard', absences: 1 },
            { course: 'T1 - Anglais', trimester_name: 'Semestre 1', ccaverage: 11, grades: [11] },
        ] })],
        ['/absences', () => json(200, { result: [{ course_name: 'Réseaux', date: now - 48 * H, justified: false }, { course_name: 'Anglais', date: now - 96 * H, justified: true }] })],
        ['/projects', () => json(200, { result: [{ project_id: 1, name: 'Projet Web', course_name: 'Web', steps: [{ psp_id: 1, psp_limit_date: now + 30 * H, psp_type: 'Rendu' }] }] })],
        ['/practicals', () => json(200, { result: [{ project_id: 2, name: 'TP Linux', steps: [{ psp_id: 2, psp_limit_date: now + 240 * H, psp_type: 'Compte rendu' }] }] })],
        ['/agenda', () => json(200, { result: [course(1, 3, 'T1 - Réseaux'), course(2, 26, 'T1 - Anglais')] })],
        ['/news', () => json(200, { result: { content: [{ ne_id: 1, title: 'Fermeture du campus', summary: 'Le campus ferme le 11.', date: now - H }] } })],
        ['/courses', () => json(200, { result: [{ rc_id: 42, name: 'T1 - Réseaux', has_documents: true, trimester: 'Semestre 1' }] })],
        ['/me/42/syllabus', () => json(200, { result: [{ ects: 4, coef: 2, control_types: [{ evaluation_label: 'Projet' }], prerequisite: 'Bases <b>réseau</b>', detail_plan: 'Routage', seance_details: [{ number: 1, content: 'Introduction' }] }] })],
        ['/me/42/files/7', () => new Response('%PDF', { headers: { 'content-type': 'application/pdf' } })],
        ['/me/42/files', () => json(200, { result: [{ oc_id: 7, label: 'Cours 1', extension: '.pdf', update_date: now }] })],
    ];
    globalThis.fetch = async (url, init = {}) => {
        for (const [pattern, respond] of routes) {
            if (String(url).includes(pattern)) return respond(String(url), init);
        }
        if (String(url).endsWith('/me')) return json(200, { result: { normalized_role: 'student', uid: 7 } });
        return json(200, { result: [] });
    };
}

test('parcours complet : connexion, chaque écran, téléchargement, déconnexion', async (t) => {
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', () => {});
    mygesMock();
    const page = browser();
    await page.settle();
    assert.match(page.text(), /Service non officiel/);

    await page.signIn('i.morel', 'mauvais');
    assert.match(page.alerts().join(), /incorrect/);
    assert.strictEqual(page.byId('password').value, '', 'mot de passe effacé après un échec');

    await page.signIn('i.morel', 'bon');
    assert.match(page.text(), /Bonjour Inès/);
    assert.match(page.text(), /Prochain cours/);
    assert.match(page.text(), /Réseaux/);
    assert.match(page.text(), /13,25/);
    assert.match(page.text(), /Absences non justifiées/);
    assert.match(page.text(), /Projet Web/);
    assert.deepStrictEqual(page.alerts(), []);

    await page.go('agenda');
    assert.match(page.text(), /Semaine du/);
    await page.button('Suivante').click();
    await page.settle();
    assert.match(page.text(), /Semaine du/);
    await page.button('Cette semaine').click();
    await page.settle();

    await page.go('notes');
    assert.match(page.text(), /Moyenne générale/);
    assert.match(page.text(), /Notes : 12 ; 14,5/);
    assert.match(page.text(), /Provisoire/);

    await page.go('absences');
    assert.match(page.text(), /Non justifiée/);
    assert.match(page.text(), /Justifiée/);

    await page.go('projets');
    assert.match(page.text(), /TP Linux/);
    assert.match(page.text(), /Projet Web/);
    assert.match(page.text(), /demain|dans 2 jours/i);

    await page.go('actualites');
    assert.match(page.text(), /Fermeture du campus/);
    assert.match(page.text(), /Le campus ferme le 11/);

    await page.go('documents');
    await page.button('Réseaux').click();
    await page.settle();
    assert.match(page.text(), /Cours 1/);
    assert.match(page.text(), /PDF/);
    await page.button('Télécharger').click();
    await page.settle();
    assert.strictEqual(page.blobs.length, 1);
    assert.strictEqual(await page.blobs[0].text(), '%PDF');
    assert.deepStrictEqual(page.alerts(), []);

    await page.button('Déconnexion').click();
    await page.settle();
    assert.match(page.text(), /Se connecter/);
});

test('alternance : le prochain cours est trouvé même dans plusieurs semaines', async (t) => {
    t.mock.method(console, 'log', () => {});
    mygesMock([['/agenda', () => json(200, { result: [course(9, 24 * 20, 'T1 - Cours lointain')] })]]);
    const page = browser();
    await page.settle();
    await page.signIn('alternant', 'bon');
    assert.match(page.text(), /Prochain cours/);
    assert.match(page.text(), /Cours lointain/);
});

test('navigation : revenir sur un écran ne recharge rien, et rien ne survit à la déconnexion', async (t) => {
    t.mock.method(console, 'log', () => {});
    mygesMock();
    const page = browser();
    await page.settle();
    await page.signIn('fluide', 'bon');
    const notes = () => page.requests.filter((u) => u === '/api/notes').length;
    await page.go('notes');
    await page.go('accueil');
    await page.go('notes');
    assert.strictEqual(notes(), 1);

    await page.button('Déconnexion').click();
    await page.settle();
    await page.signIn('fluide', 'bon');
    await page.go('notes');
    assert.strictEqual(notes(), 2);
});

test('navigation : menu Plus, flèches du clavier et semaine suivante préchargée', async (t) => {
    t.mock.method(console, 'log', () => {});
    mygesMock();
    const page = browser();
    await page.settle();
    await page.signIn('clavier', 'bon');

    const plus = page.button('Plus');
    await plus.click();
    assert.strictEqual(plus.getAttribute('aria-expanded'), 'true');
    await page.go('absences');
    assert.strictEqual(plus.getAttribute('aria-expanded'), 'false');
    assert.strictEqual(plus.getAttribute('data-current'), 'true');

    await page.go('agenda');
    assert.ok(page.requests.some((u) => u.startsWith('/api/agenda?week=')), 'semaine suivante préchargée');
    const before = page.text().match(/Semaine du .+? au \S+ \S+/)[0];
    page.windowListeners.keydown({ key: 'ArrowRight', target: {} });
    await page.settle();
    assert.notStrictEqual(page.text().match(/Semaine du .+? au \S+ \S+/)[0], before);
});

test('agenda : grille placée selon l\'heure de Paris, cours aussi lisible en liste', async (t) => {
    t.mock.method(console, 'log', () => {});
    const start = new Date();
    start.setHours(10, 30, 0, 0);
    mygesMock([['/agenda', () => json(200, { result: [{ reservation_id: 5, name: 'T1 - Examen final', type: 'Examen', start_date: start.getTime(), end_date: start.getTime() + 2 * H, rooms: [] }] })]]);
    const page = browser();
    await page.settle();
    await page.signIn('grille', 'bon');
    await page.go('agenda');
    const block = page.root.all((e) => e.className.startsWith('event'))[0];
    assert.strictEqual(block.className, 'event exam');
    assert.strictEqual(block.style.vars['--start'], '30'); // 10 h 30, grille à partir de 10 h
    assert.strictEqual(block.style.vars['--length'], '120');
    assert.ok(page.root.all((e) => e.className.includes('only-narrow')).length > 0);
});

test('agenda : semaine vide, un bouton mène au prochain cours', async (t) => {
    t.mock.method(console, 'log', () => {});
    const later = Date.now() + 20 * 24 * H;
    mygesMock([['/agenda', (url) => json(200, { result: Number(new URL(url).searchParams.get('start')) > Date.now() ? [{ reservation_id: 8, name: 'Plus tard', start_date: later, end_date: later + H }] : [] })]]);
    const page = browser();
    await page.settle();
    await page.signIn('vide2', 'bon');
    await page.go('agenda');
    assert.match(page.text(), /Aucun cours cette semaine/);
    await page.button('Prochain cours').click();
    await page.settle();
    assert.match(page.text(), /Plus tard/);
});

test('documents : dossiers, catégories et recherche', async (t) => {
    t.mock.method(console, 'log', () => {});
    const docs = Array.from({ length: 7 }, (_, i) => ({ document_id: i + 1, name: i ? `Guide ${i}` : 'Calendrier', extension: '.pdf', category: i ? 'INFORMATIONS GENERALES' : 'CALENDRIERS' }));
    mygesMock([['/annualDocuments', () => json(200, { result: docs })]]);
    const page = browser();
    await page.settle();
    await page.signIn('dossiers', 'bon');
    await page.go('documents');
    await page.button('Documents annuels').click();
    await page.settle();
    assert.match(page.text(), /Calendriers/);
    assert.match(page.text(), /Informations generales/);

    await page.root.all((e) => e.className === 'tab' && e.textContent === 'Calendriers')[0].click();
    assert.doesNotMatch(page.text(), /Guide 3/);
    await page.button('Tout').click();
    assert.match(page.text(), /Guide 3/);

    const search = page.byId('recherche');
    await search.fire('input', { target: { value: 'calend' } });
    assert.match(page.text(), /Calendrier/);
    assert.doesNotMatch(page.text(), /Guide 3/);
    await search.fire('input', { target: { value: 'introuvable' } });
    assert.match(page.text(), /Aucun fichier ne correspond/);
});

test('clic sur un cours : détail, syllabus, et accès direct aux supports', async (t) => {
    t.mock.method(console, 'log', () => {});
    mygesMock();
    const page = browser();
    await page.settle();
    await page.signIn('detail', 'bon');
    await page.go('agenda');

    await page.root.all((e) => e.className.startsWith('event'))[0].click();
    await page.settle();
    const dialog = page.root.all((e) => e.tag === 'dialog')[0];
    const shown = dialog.textContent;
    for (const expected of [/Salle 12 \(Nation 1\)/, /2ème étage/, /M\. Bernard/, /Présentiel/, /Semestre 1/, /Groupe A/, /24 étudiants/, /2 h/, /Projet/, /Bases réseau/, /Routage/, /1 séance/]) {
        assert.match(shown, expected);
    }

    await dialog.all((e) => e.tag === 'button' && e.textContent.includes('Voir les supports'))[0].click();
    await page.settle();
    assert.strictEqual(page.root.all((e) => e.tag === 'dialog').length, 0);
});

test('agenda : deux cours simultanés sont côte à côte, l\'échelle s\'adapte au plus court', async (t) => {
    t.mock.method(console, 'log', () => {});
    const start = new Date();
    start.setHours(10, 0, 0, 0);
    const at = (id, offset, length) => ({ reservation_id: id, name: `Cours ${id}`, start_date: start.getTime() + offset * 60_000, end_date: start.getTime() + (offset + length) * 60_000, rooms: [] });
    mygesMock([['/agenda', () => json(200, { result: [at(1, 0, 120), at(2, 30, 30), at(3, 180, 60)] })]]);
    const page = browser();
    await page.settle();
    await page.signIn('voies', 'bon');
    await page.go('agenda');
    const blocks = Object.fromEntries(page.root.all((e) => e.className.startsWith('event')).map((e) => [e.textContent.match(/Cours \d/)[0], e.style.vars]));
    assert.deepStrictEqual([blocks['Cours 1']['--lane'], blocks['Cours 1']['--lanes']], ['0', '2']);
    assert.deepStrictEqual([blocks['Cours 2']['--lane'], blocks['Cours 2']['--lanes']], ['1', '2']);
    assert.deepStrictEqual([blocks['Cours 3']['--lane'], blocks['Cours 3']['--lanes']], ['0', '1']);
    assert.strictEqual(page.root.all((e) => e.className.includes('week') && e.style.vars['--scale'])[0].style.vars['--scale'], '1.5');
});

test('projets : onglets, page détaillée, seul son groupe y figure, consigne téléchargeable', async (t) => {
    t.mock.method(console, 'log', () => {});
    const long = 'Texte complet. '.repeat(30);
    const project = {
        project_id: 1, name: 'Projet Web', course_name: 'Web', author: 'Mme Durand', project_teaching_goals: 'Construire une API', project_type_group: 'Libre', project_min_student_group: 1, project_max_student_group: 4,
        steps: [
            { psp_id: 1, psp_limit_date: now - 48 * H, psp_type: 'Cahier des charges', files: [{ psf_id: 11, pgr_id: 5, psf_name: 'Rendu A', psf_file_type: '.pdf' }, { psf_id: 12, pgr_id: 6, psf_name: 'Rendu autre groupe' }] },
            { psp_id: 2, psp_limit_date: now + 30 * H, psp_type: 'Rendu', psp_desc: 'Dépôt du code', files: [] },
        ],
        project_files: [{ pf_id: 21, pf_title: 'Consignes', pf_file: 'consignes.pdf', pf_crea_date: now }],
        groups: [
            { project_group_id: 5, group_name: 'Groupe 5', subject_validated: true, teacher_comment: 'Bon début', teacher_intern_comment: 'NOTE INTERNE', project_group_students: [{ u_id: 7, firstname: 'Inès', name: 'Morel' }] },
            { project_group_id: 6, group_name: 'Groupe 6', project_group_students: [{ u_id: 8, firstname: 'Autre', name: 'Personne' }] },
        ],
        project_group_logs: [{ pgr_id: 5, pgl_author: 'Inès Morel', pgl_describe: 'a déposé un fichier', pgl_date: now - H }, { pgr_id: 6, pgl_author: 'Autre Personne', pgl_describe: 'action étrangère', pgl_date: now }],
    };
    mygesMock([
        ['/projects', () => json(200, { result: [project, { project_id: 2, name: 'Projet fini', steps: [{ psp_id: 3, psp_limit_date: now - H, psp_type: 'Rendu' }] }] })],
        ['/practicals', () => json(200, { result: [] })],
        ['/me/projectFiles/21', () => new Response('%PDF', { headers: { 'content-type': 'application/pdf' } })],
        ['/news', () => json(200, { result: { content: [{ title: 'Longue actu', html: `<p>${long}</p>`, date: now }] } })],
    ]);
    const page = browser();
    await page.settle();
    await page.signIn('lecture', 'bon');

    await page.go('projets');
    assert.match(page.text(), /En cours \(1\)/);
    assert.match(page.text(), /Terminés \(1\)/);
    assert.match(page.text(), /Étape 1 sur 2/);
    assert.match(page.text(), /Projet fini/);
    assert.strictEqual(page.root.all((e) => e.className === 'project-card').length, 1);

    await page.go('projet/1');
    const text = page.text();
    for (const expected of [/Construire une API/, /prochaine étape/, /Dépôt du code/, /Rendu A/, /Consignes/, /Groupe 5/, /Inès Morel/, /Validé/, /Bon début/, /Mme Durand/, /1 à 4 personnes/, /a déposé un fichier/, /Équipes \(2\)/]) {
        assert.match(text, expected);
    }
    for (const hidden of [/NOTE INTERNE/, /Rendu autre groupe/, /action étrangère/, /Groupe 6/]) assert.doesNotMatch(text, hidden);

    // Deuxième page du projet : les équipes, noms et membres seulement.
    await page.go('projet/1/equipes');
    const teams = page.text();
    assert.match(teams, /Groupe 6/);
    assert.match(teams, /Autre Personne/);
    assert.match(teams, /Mon équipe/);
    for (const hidden of [/NOTE INTERNE/, /Rendu autre groupe/, /action étrangère/, /Bon début/, /Construire une API/]) assert.doesNotMatch(teams, hidden);
    await page.go('projet/1');

    await page.root.all((e) => e.attrs['aria-label'] === 'Télécharger Consignes')[0].click();
    await page.settle();
    assert.strictEqual(await page.blobs.at(-1).text(), '%PDF');

    await page.go('actualites');
    await page.button('Lire la suite').click();
    assert.ok(page.root.all((e) => e.tag === 'dialog')[0].textContent.length > 300);
});

test('projets : sans groupe, l\'étudiant le voit tout de suite', async (t) => {
    t.mock.method(console, 'log', () => {});
    mygesMock([
        ['/projects', () => json(200, { result: [{ project_id: 1, name: 'Sans groupe', groups: [], steps: [{ psp_id: 1, psp_limit_date: now + 30 * H, psp_type: 'Rendu' }] }] })],
        ['/practicals', () => json(200, { result: [] })],
    ]);
    const page = browser();
    await page.settle();
    await page.signIn('seul', 'bon');
    await page.go('projets');
    assert.match(page.text(), /Pas encore de groupe/);
    await page.go('projet/1');
    assert.match(page.text(), /aucun groupe pour ce projet/);
    await page.go('projet/999');
    assert.match(page.alerts().join(), /introuvable/);
});

test('équipes : rejoindre passe par une confirmation, puis la page se met à jour', async (t) => {
    t.mock.method(console, 'log', () => {});
    const writes = [];
    const members = [{ u_id: 8, firstname: 'Autre', name: 'Personne' }];
    const project = () => ({ project_id: 1, rc_id: 9, name: 'Projet libre', project_type_group: 'Libre', project_max_student_group: 2, steps: [{ psp_id: 1, psp_limit_date: now + 30 * H, psp_type: 'Rendu' }], groups: [{ project_group_id: 6, group_name: 'Groupe 6', project_group_students: [...members] }, { project_group_id: 7, group_name: 'Groupe 7', project_group_students: [{ u_id: 1 }, { u_id: 2 }] }] });
    mygesMock([
        ['/me/courses/9/projects/1/groups/6', (url, init) => {
            writes.push(init.method);
            members.push({ u_id: 7, firstname: 'Inès', name: 'Morel' });
            return json(200, { result: {} });
        }],
        ['/projects', () => json(200, { result: [project()] })],
        ['/practicals', () => json(200, { result: [] })],
    ]);
    const page = browser();
    await page.settle();
    await page.signIn('joint', 'bon');
    await page.go('projet/1/equipes');
    assert.match(page.text(), /Personne/);
    assert.match(page.text(), /Complet, 2 \/ 2/);
    assert.strictEqual(page.root.all((e) => e.attrs['aria-label'] === 'Rejoindre Groupe 7').length, 0);

    await page.root.all((e) => e.attrs['aria-label'] === 'Rejoindre Groupe 6')[0].click();
    assert.deepStrictEqual(writes, [], 'rien ne part avant la confirmation');
    await page.button('Rejoindre l\'équipe').click();
    await page.settle();
    assert.deepStrictEqual(writes, ['POST']);
    assert.match(page.text(), /Mon équipe/);
    assert.ok(page.root.all((e) => e.attrs['aria-label'] === 'Quitter Groupe 6').length);
});

test('absences : chiffres, filtre, mois et matières', async (t) => {
    t.mock.method(console, 'log', () => {});
    const at = (date, course, justified) => ({ course_name: course, date: Date.parse(date), justified });
    mygesMock([
        ['/absences', () => json(200, { result: [at('2026-10-05T10:00:00Z', 'Réseaux', false), at('2026-10-06T10:00:00Z', 'Réseaux', true), at('2026-09-07T10:00:00Z', 'Anglais', true)] })],
        ['/grades', () => json(200, { result: [{ course: 'T1 - Réseaux', trimester_name: 'Semestre 1', absences: 1, lates: 2 }, { course: 'T1 - Anglais', trimester_name: 'Semestre 1', absences: 0, lates: 0 }] })],
    ]);
    const page = browser();
    await page.settle();
    await page.signIn('abs', 'bon');
    await page.go('absences');
    for (const expected of [/Octobre 2026 \(2\)/, /Septembre 2026 \(1\)/, /Par matière/, /Retards/, /Toutes \(3\)/]) assert.match(page.text(), expected);
    assert.match(page.root.all((e) => e.tag === 'tbody')[0].textContent, /Réseaux 1 2/);
    await page.button('Non justifiées').click();
    assert.doesNotMatch(page.text(), /Septembre 2026/);
});

test('absences : sans absence, l\'écran garde ses chiffres et le détail par matière', async (t) => {
    t.mock.method(console, 'log', () => {});
    mygesMock([
        ['/absences', () => new Response(null, { status: 204 })],
        ['/grades', () => json(200, { result: [{ course: 'T1 - Web', trimester_name: 'Semestre 1', absences: 0, lates: 1 }] })],
    ]);
    const page = browser();
    await page.settle();
    await page.signIn('assidu', 'bon');
    await page.go('absences');
    for (const expected of [/Non justifiées/, /Justifiées/, /Retards/, /Aucune absence enregistrée/, /Par matière/]) assert.match(page.text(), expected);
    assert.match(page.root.all((e) => e.tag === 'tbody')[0].textContent, /Web 0 1/);
    assert.strictEqual(page.root.all((e) => e.className === 'tab').length, 0);
});

test('absences : une panne des notes n\'empêche pas de voir les absences', async (t) => {
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', () => {});
    mygesMock([
        ['/absences', () => json(200, { result: [{ course_name: 'Web', date: now - H, justified: false }] })],
        ['/grades', () => json(404, {})],
    ]);
    const page = browser();
    await page.settle();
    await page.signIn('sansnotes', 'bon');
    await page.go('absences');
    assert.match(page.text(), /Non justifiée/);
    assert.doesNotMatch(page.text(), /Par matière/);
});

test('panel qui redémarre : la réponse de nginx donne un message clair', async (t) => {
    t.mock.method(console, 'log', () => {});
    mygesMock();
    const page = browser();
    await page.settle();
    await page.signIn('redemarre', 'bon');
    page.failNext(503, '<html>indisponible</html>');
    await page.go('notes');
    assert.match(page.alerts().join(), /Le panel redémarre/);
});

test('annuaire et profil : listes, recherche, e-mail d\'intervenant, export de l\'agenda', async (t) => {
    t.mock.method(console, 'log', () => {});
    mygesMock([
        ['/me/classes/3/students', () => json(200, { result: [{ uid: 8, firstname: 'Léa', lastname: 'Martin' }, { uid: 9, firstname: 'Tom', lastname: 'Petit' }] })],
        ['/classes', () => json(200, { result: [{ puid: 3, name: '3A', promotion: 'Promo 2026', school: 'ESGI' }] })],
        ['/teachers', () => json(200, { result: [{ uid: 20, firstname: 'Marie', lastname: 'Curie', email: 'marie@ecole.test' }] })],
        ['/me/profile', () => json(200, { result: { firstname: 'Inès', name: 'Morel', email: 'ines@ecole.test' } })],
    ]);
    const page = browser();
    await page.settle();
    await page.signIn('annuaire', 'bon');

    await page.go('annuaire');
    assert.match(page.text(), /Ma classe \(2\)/);
    assert.match(page.text(), /Léa Martin/);
    const search = page.byId('recherche-annuaire');
    await search.fire('input', { target: { value: 'petit' } });
    assert.doesNotMatch(page.text(), /Léa Martin/);
    await search.fire('input', { target: { value: '' } });

    await page.root.all((e) => e.className === 'tab' && e.textContent.includes('Intervenants'))[0].click();
    assert.match(page.text(), /Marie Curie/);
    assert.strictEqual(page.root.all((e) => e.attrs.href === 'mailto:marie@ecole.test').length, 1);

    await page.go('profil');
    for (const expected of [/Inès Morel/, /ines@ecole\.test/, /3A/, /Promo 2026/, /ESGI/]) assert.match(page.text(), expected);

    await page.go('agenda');
    await page.button('Télécharger le fichier .ics').click();
    await page.settle();
    assert.match(await page.blobs.at(-1).text(), /BEGIN:VCALENDAR/);
    assert.deepStrictEqual(page.alerts(), []);
});

test('agenda au mois : cours par jour, jour choisi ouvert en semaine, mois suivant', async (t) => {
    t.mock.method(console, 'log', () => {});
    mygesMock([['/agenda', (url) => {
        const start = Number(new URL(url).searchParams.get('start'));
        const first = Date.parse('2026-11-23T09:00:00+01:00');
        return json(200, { result: start <= first && Number(new URL(url).searchParams.get('end')) >= first ? [
            { reservation_id: 1, name: 'Réseaux', type: 'Cours', start_date: first, end_date: first + H, rooms: [] },
            { reservation_id: 2, name: 'Partiel', type: 'Examen', start_date: first + 2 * H, end_date: first + 3 * H, rooms: [] },
        ] : [] });
    }]]);
    const page = browser();
    await page.settle();
    await page.signIn('mois', 'bon');
    await page.go('agenda');
    await page.root.all((e) => e.className === 'tab' && e.textContent === 'Mois')[0].click();
    await page.settle();

    const day = () => page.root.all((e) => e.attrs['aria-label']?.startsWith('lundi 23 novembre'))[0];
    let safety = 0;
    while (!day() && safety++ < 24) {
        await page.button('Suivant').click();
        await page.settle();
    }
    assert.ok(day(), 'le 23 novembre est affiché');
    assert.match(day().attrs['aria-label'], /2 cours/);
    assert.match(day().textContent, /2 cours/);
    assert.match(day().textContent, /Examen/);
    assert.match(page.text(), /2 cours ce mois-ci/);
    assert.strictEqual(page.root.all((e) => e.tag === 'tbody').at(-1).all((e) => e.tag === 'tr').every((row) => row.kids.length === 7), true);

    await day().click();
    await page.settle();
    assert.match(page.text(), /Semaine du 23 novembre/);
    assert.match(page.text(), /Réseaux/);
});

test('événements : à venir et passés, détail au clic', async (t) => {
    t.mock.method(console, 'log', () => {});
    mygesMock([['/me/events', () => json(200, { result: [
        { event_id: 1, event_title: 'Forum entreprises', event_date: now + 48 * H, location: 'Nation', description: 'Rencontres', end_subscription_date: now + 24 * H, is_participant_subscribed: true },
        { event_id: 2, event_title: 'Conférence passée', event_date: now - 48 * H },
    ] })]]);
    const page = browser();
    await page.settle();
    await page.signIn('events', 'bon');
    await page.go('evenements');
    assert.match(page.text(), /À venir \(1\)/);
    assert.match(page.text(), /Passés \(1\)/);
    assert.match(page.text(), /Forum entreprises/);
    assert.doesNotMatch(page.text(), /Conférence passée/);
    await page.root.all((e) => e.className === 'tab' && e.textContent.startsWith('Passés'))[0].click();
    assert.match(page.text(), /Conférence passée/);
    await page.root.all((e) => e.className === 'tab' && e.textContent.startsWith('À venir'))[0].click();
    await page.button('Forum entreprises').click();
    assert.match(page.root.all((e) => e.tag === 'dialog')[0].textContent, /Rencontres/);
    assert.match(page.root.all((e) => e.tag === 'dialog')[0].textContent, /Tu es inscrit/);
});

test('installation : le bouton n\'apparaît que si le navigateur le propose, sinon la marche à suivre', async (t) => {
    t.mock.method(console, 'log', () => {});
    mygesMock();
    const page = browser();
    await page.settle();
    await page.signIn('install', 'bon');
    await page.go('profil');
    assert.match(page.text(), /Sur ton téléphone/);
    assert.match(page.text(), /écran d'accueil/);
    assert.strictEqual(page.root.all((e) => e.tag === 'button' && e.textContent.includes('Installer l\'application')).length, 0);

    let prompted = 0;
    page.windowListeners.beforeinstallprompt({ preventDefault() {}, prompt: async () => { prompted++; } });
    await page.go('accueil');
    await page.go('profil');
    await page.button('Installer l\'application').click();
    await page.settle();
    assert.strictEqual(prompted, 1);
});

test('connexion : la case « Rester connecté » existe, décochée, et sa valeur est transmise', async (t) => {
    t.mock.method(console, 'log', () => {});
    mygesMock();
    const page = browser();
    await page.settle();
    const box = page.byId('remember');
    assert.ok(box);
    assert.ok(!box.checked);
    assert.match(page.text(), /ordinateur partagé/);
    assert.match(page.text(), /jeton chiffré/);
    box.checked = true;
    await page.signIn('coche', 'bon');
    assert.match(page.text(), /Bonjour Inès/);
    assert.match(page.lastCookie(), /Max-Age=\d+/);
});

test('accueil : cours suivants, événements et actualités', async (t) => {
    t.mock.method(console, 'log', () => {});
    mygesMock([
        ['/me/events', () => json(200, { result: [{ event_id: 1, event_title: 'Forum entreprises', event_date: now + 48 * H, location: 'Nation', description: 'Rencontres' }, { event_id: 2, event_title: 'Passé', event_date: now - H }] })],
        ['/news', () => json(200, { result: { content: [{ title: 'Fermeture du campus', html: '<p>Texte</p>', date: now }] } })],
    ]);
    const page = browser();
    await page.settle();
    await page.signIn('accueil', 'bon');
    for (const expected of [/Ensuite/, /Forum entreprises/, /Fermeture du campus/, /Projets en cours/, /Cours à venir/]) assert.match(page.text(), expected);
    assert.doesNotMatch(page.text(), /Passé/);
    await page.button('Forum entreprises').click();
    assert.match(page.root.all((e) => e.tag === 'dialog')[0].textContent, /Rencontres/);
});

test('photos : initiales toujours présentes, photo retirée si elle ne charge pas', async (t) => {
    t.mock.method(console, 'log', () => {});
    mygesMock([
        ['/projects', () => json(200, { result: [{ project_id: 1, name: 'P', project_type_group: 'Libre', steps: [], groups: [{ project_group_id: 5, group_name: 'G', project_group_students: [{ u_id: 8, firstname: 'Léa', name: 'Roux' }, { firstname: 'Sans', name: 'Numéro' }] }] }] })],
        ['/practicals', () => json(200, { result: [] })],
    ]);
    const page = browser();
    await page.settle();
    await page.signIn('visages', 'bon');
    assert.ok(page.root.all((e) => e.tag === 'img' && e.attrs.src === '/api/photos/moi').length === 1, 'sa propre photo dans l\'en-tête');

    await page.go('projet/1/equipes');
    const img = page.root.all((e) => e.tag === 'img' && e.attrs.src === '/api/photos/8')[0];
    assert.strictEqual(img.attrs.loading, 'lazy');
    assert.strictEqual(img.attrs.alt, '');
    assert.match(img.parent.textContent, /LR/);
    await img.fire('error');
    assert.strictEqual(page.root.all((e) => e.tag === 'img' && e.attrs.src === '/api/photos/8').length, 0);
    assert.match(page.text(), /LR/);
    assert.strictEqual(page.root.all((e) => e.tag === 'img' && /undefined|null/.test(e.attrs.src)).length, 0, 'pas de requête sans identifiant');
});

test('agenda : une semaine vide garde sa grille', async (t) => {
    t.mock.method(console, 'log', () => {});
    mygesMock([['/agenda', () => json(200, { result: [] })]]);
    const page = browser();
    await page.settle();
    await page.signIn('grillevide', 'bon');
    await page.go('agenda');
    assert.match(page.text(), /Aucun cours cette semaine/);
    const week = page.root.all((e) => e.className.includes('week') && e.style.vars['--days'])[0];
    assert.strictEqual(week.style.vars['--days'], '5');
    assert.strictEqual(week.style.vars['--hours'], '10');
    assert.strictEqual(page.root.all((e) => e.className === 'week-day').length + page.root.all((e) => e.attrs['data-today']).length >= 5, true);
    assert.strictEqual(page.root.all((e) => e.className.startsWith('event')).length, 0);
});

test('notes : moyenne provisoire, tri, et détail d\'une matière au clic', async (t) => {
    t.mock.method(console, 'log', () => {});
    mygesMock([['/grades', () => json(200, { result: [
        { course: 'T1 - Anglais', trimester_name: 'Semestre 1', ccaverage: 9, grades: [9], ects: '2.0', coef: '2.0', lates: 1, rc_id: 42, teacher_last_name: 'Martin' },
        { course: 'T1 - Web', trimester_name: 'Semestre 1', ccaverage: 15, grades: [15], ects: '4.0' },
        { course: 'T1 - Droit', trimester_name: 'Semestre 1' },
    ] })]]);
    const page = browser();
    await page.settle();
    await page.signIn('notes', 'bon');
    assert.match(page.text(), /Moyenne provisoire/);

    await page.go('notes');
    assert.match(page.text(), /13,00/); // (9 × 2 + 15 × 4) / 6
    assert.match(page.text(), /0 matière sur 3 avec une moyenne définitive/);
    const low = page.root.all((e) => e.className.includes('bar') && e.className.includes('low'));
    assert.ok(low.length > 0, 'note sous la moyenne repérée');

    const order = () => {
        const text = page.root.all((e) => e.tag === 'ul' && e.className.includes('rows'))[0].textContent;
        return ['Anglais', 'Droit', 'Web'].sort((a, b) => text.indexOf(a) - text.indexOf(b));
    };
    assert.deepStrictEqual(order(), ['Anglais', 'Droit', 'Web']);
    const sort = page.byId('tri');
    await sort.fire('change', { target: { value: 'haute' } });
    assert.deepStrictEqual(order(), ['Web', 'Anglais', 'Droit']);
    await sort.fire('change', { target: { value: 'basse' } });
    assert.deepStrictEqual(order(), ['Anglais', 'Web', 'Droit']);

    await page.button('Anglais').click();
    await page.settle();
    const dialog = page.root.all((e) => e.tag === 'dialog')[0].textContent;
    for (const expected of [/Contrôle continu/, /9,00 \/ 20/, /Retards/, /Martin/, /Voir les supports/]) assert.match(dialog, expected);
});

test('notes : une lettre sans note chiffrée n\'est pas présentée comme un résultat', async (t) => {
    t.mock.method(console, 'log', () => {});
    mygesMock([['/grades', () => json(200, { result: [
        { course: 'T1 - Anglais', trimester_name: 'Semestre 1', letter_mark: 'B' },
        { course: 'T1 - Web', trimester_name: 'Semestre 1', letter_mark: 'B', average: 14 },
    ] })]]);
    const page = browser();
    await page.settle();
    await page.signIn('lettre', 'bon');
    await page.go('notes');
    const name = (label) => page.root.all((e) => e.tag === 'button' && e.className === 'course' && e.textContent.includes(label))[0];
    assert.match(name('Anglais').textContent, /Pas de note/);

    await name('Anglais').click();
    assert.doesNotMatch(page.root.all((e) => e.tag === 'dialog')[0].textContent, /Mention/);
    await page.root.all((e) => e.tag === 'dialog')[0].close();

    await name('Web').click();
    assert.match(page.root.all((e) => e.tag === 'dialog')[0].textContent, /Mention/);
});

test('session expirée en cours de route : retour à la connexion avec un message', async (t) => {
    t.mock.method(console, 'log', () => {});
    let expired = false;
    mygesMock([['/courses', () => (expired ? json(401, {}) : json(200, { result: [] }))]]);
    const page = browser();
    await page.settle();
    await page.signIn('expire', 'bon');
    expired = true;
    await page.go('documents');
    assert.match(page.text(), /Se connecter/);
    assert.match(page.alerts().join(), /session a expiré/);
});

test('MyGes en panne : message et bouton Réessayer, l\'écran n\'est pas blanc', async (t) => {
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', () => {});
    let down = true;
    mygesMock([['/absences', () => (down ? json(404, {}) : json(200, { result: [] }))]]);
    const page = browser();
    await page.settle();
    await page.signIn('panne', 'bon');
    await page.go('absences');
    assert.match(page.alerts().join(), /ne répond pas/);

    down = false;
    await page.button('Réessayer').click();
    await page.settle();
    assert.match(page.text(), /Aucune absence/);
});

test('accueil sans cours ni données : états vides lisibles', async (t) => {
    t.mock.method(console, 'log', () => {});
    mygesMock([
        ['/agenda', () => new Response(null, { status: 204 })],
        ['/grades', () => new Response(null, { status: 204 })],
        ['/absences', () => new Response(null, { status: 204 })],
        ['/projects', () => new Response(null, { status: 204 })],
        ['/practicals', () => new Response(null, { status: 204 })],
    ]);
    const page = browser();
    await page.settle();
    await page.signIn('vide', 'bon');
    assert.match(page.text(), /Aucun cours dans les 6 prochaines semaines/);
    assert.match(page.text(), /Rien à rendre/);
});
