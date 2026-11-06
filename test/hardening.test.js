// Constats de l'audit de sécurité : gel du bot, contrôle d'accès, données exposées.
// Chaque module est chargé dans son test : un seul oubli n'en masque pas d'autres.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { dist, mockFetch, json } = require('./helpers');

const token = { token_type: 'bearer', access_token: 't' };

test('snippet : un texte hostile ne gèle pas le bot', () => {
    const { snippet } = dist('utils/format.js');
    const started = performance.now();
    snippet('<'.repeat(200_000));
    snippet(`<a${' '.repeat(200_000)}`);
    assert.ok(performance.now() - started < 300, `${Math.round(performance.now() - started)} ms`);
});

test('rendu : un nom de cours démesuré reste rapide', () => {
    const { fitText, ensureFonts, FONT_BOLD } = dist('utils/canvasBase.js');
    const { createCanvas } = require('@napi-rs/canvas');
    ensureFonts();
    const ctx = createCanvas(300, 100).getContext('2d');
    const started = performance.now();
    fitText(ctx, 'x'.repeat(5_000), 200, 60, FONT_BOLD, 15, 9);
    assert.ok(performance.now() - started < 1_000, `${Math.round(performance.now() - started)} ms`);
});

test('rendu : un travail bloqué est refusé, jamais rejoué sur le thread principal', async (t) => {
    const { renderAgendaWeek, shutdownRenderPool } = dist('utils/renderPool.js');
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', () => {});
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const job = renderAgendaWeek([], new Date('2026-11-02'));
    t.mock.timers.tick(15_000);
    await assert.rejects(job, /interrompu/);
    await shutdownRenderPool();
});

test('photo : une redirection hors de MyGes est refusée, celle vers MyGes suivie', async (t) => {
    const { fetchPhotoBuffer } = dist('utils/photo.js');
    t.mock.method(console, 'error', () => {});
    const to = (location) => new Response(null, { status: 302, headers: { location } });

    let calls = mockFetch([to('http://169.254.169.254/secret')]);
    assert.strictEqual(await fetchPhotoBuffer('https://api.kordis.fr/a.jpg', token, new Map()), null);
    assert.strictEqual(calls.length, 1);

    calls = mockFetch([to('https://ges-dl.kordis.fr/a.jpg'), new Response('img')]);
    assert.strictEqual((await fetchPhotoBuffer('https://api.kordis.fr/b.jpg', token, new Map())).toString(), 'img');
    assert.strictEqual(calls[1].url, 'https://ges-dl.kordis.fr/a.jpg');
});

test('réponse JSON démesurée refusée sans être chargée', async () => {
    const { BaseService } = dist('myges/services/base.js');
    const { FileTooLargeError } = dist('myges/errors.js');
    mockFetch([new Response('{}', { headers: { 'content-length': String(50 * 1024 * 1024) } })]);
    await assert.rejects(BaseService.request(token, 'GET', '/me/x'), FileTooLargeError);
});

/** Faux clic sur « Partager ». */
function shareClick({ userId = 'u1', canSend = true, guild = true } = {}) {
    const sent = { replies: [], followUps: [] };
    return Object.assign(sent, {
        i: {
            user: { id: userId, tag: userId },
            channelId: 'c',
            inGuild: () => guild,
            memberPermissions: guild ? { has: () => canSend } : null,
            message: { attachments: new Map(), embeds: [], content: 'vue' },
            deferUpdate: async () => {},
            reply: async (r) => sent.replies.push(r),
            followUp: async (r) => sent.followUps.push(r),
        },
    });
}

test('partage : refusé à qui n\'a pas le droit d\'écrire dans le salon', async () => {
    const { handleShare } = dist('utils/share.js');
    const click = shareClick({ userId: 'muet', canSend: false });
    await handleShare(click.i);
    assert.strictEqual(click.followUps.length, 0);
    assert.match(click.replies[0].content, /droit d'écrire/);
});

test('partage : limité en fréquence', async (t) => {
    const { handleShare } = dist('utils/share.js');
    t.mock.method(console, 'log', () => {});
    const results = [];
    for (let n = 0; n < 5; n++) {
        const click = shareClick({ userId: 'bavard' });
        await handleShare(click.i);
        results.push(click.followUps.length);
    }
    assert.deepStrictEqual(results, [1, 1, 1, 0, 0]);
});

test('/trombi et /profs ne proposent plus de publier la fiche d\'une personne', () => {
    for (const file of ['trombi', 'profs']) {
        const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'commands', `${file}.ts`), 'utf-8');
        assert.doesNotMatch(source, /shareRow|SHARE_ID/, file);
    }
});

test('clics : au-delà du seuil, l\'action est refusée et l\'utilisateur prévenu', async () => {
    const { tooManyClicks } = dist('utils/collector.js');
    const replies = [];
    const click = { user: { id: 'cliqueur' }, reply: async (r) => replies.push(r) };
    let refused = 0;
    for (let n = 0; n < 25; n++) if (await tooManyClicks(click)) refused++;
    assert.strictEqual(refused, 5);
    assert.strictEqual(replies.length, 5);
});

test('collecteur : arrêté avant que le jeton d\'interaction n\'expire, même si on clique sans arrêt', (t) => {
    const { limitLifetime } = dist('utils/collector.js');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const collector = Object.assign(new EventEmitter(), { stopped: null, stop(reason) { this.stopped = reason; } });
    limitLifetime(collector);
    t.mock.timers.tick(14 * 60_000);
    assert.ok(collector.stopped);
});

test('fichiers sensibles : droits resserrés au démarrage', (t) => {
    const { tightenPermissions } = dist('core/store.js');
    t.mock.method(console, 'log', () => {});
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'perm-')), 'secret');
    fs.writeFileSync(file, 'x', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    tightenPermissions([file, `${file}.absent`]);
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
});

test('/campus : une session en mémoire dont MyGes refuse le jeton ne donne plus les codes', async () => {
    const store = dist('core/store.js');
    const { encrypt } = dist('crypto.js');
    const campus = dist('commands/campus.js').default;
    const data = store.loadData();
    data.users.parti = { user: encrypt('p.nom'), pass: encrypt('perime') };
    store.saveData(data);
    store.openSession('parti', token);
    const calls = mockFetch([json(401, {}), json(401, {})]); // profil, puis reconnexion
    const replies = [];
    await campus.execute({
        user: { id: 'parti' }, client: { user: null },
        deferReply: async () => {}, reply: async (r) => replies.push(r), editReply: async (r) => replies.push(r),
    });
    assert.ok(calls.length >= 1);
    assert.ok(!replies.at(-1).embeds, 'les codes ne doivent pas être affichés');
});

test('empreintes : deux étudiants ayant la même note n\'ont pas la même empreinte', async (t) => {
    const store = dist('core/store.js');
    const { encrypt } = dist('crypto.js');
    const { runPersonalCheck } = dist('tasks/personalAlerts.js');
    const data = store.loadData();
    for (const id of Object.keys(data.users)) delete data.users[id];
    for (const id of ['e1', 'e2']) {
        data.users[id] = { user: encrypt(id), pass: encrypt('x') };
        Object.assign(store.getUserAlerts(data, id), { reminders: false, agenda: false, digest: false });
    }
    store.saveData(data);
    const body = (u) => (u.includes('grades') ? [{ course: 'Web', trimester_name: 'T1', grades: [12] }] : [{ course_name: 'Web', date: 1000 }]);
    globalThis.fetch = async (url) => (String(url).includes('oauth')
        ? new Response(null, { status: 302, headers: { location: 'x:/#access_token=t&token_type=bearer&expires_in=86400' } })
        : json(200, { result: body(String(url)) }));
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const cycle = runPersonalCheck({});
    for (let n = 0; n < 10; n++) {
        await new Promise(setImmediate);
        t.mock.timers.tick(2_000);
    }
    await cycle;
    const { e1, e2 } = store.loadData().alerts;
    assert.ok(e1.knownGrades.length && e1.knownAbsences.length);
    assert.notDeepStrictEqual(e1.knownGrades, e2.knownGrades);
    assert.notDeepStrictEqual(e1.knownAbsences, e2.knownAbsences);
});

test('rappels : chiffrés, et l\'ancien format repris sans renvoyer ce qui est déjà parti', async (t) => {
    const store = dist('core/store.js');
    const { encrypt } = dist('crypto.js');
    const { runPersonalCheck } = dist('tasks/personalAlerts.js');
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-10T10:00:00Z') });
    const now = Date.now();
    const data = store.loadData();
    for (const id of Object.keys(data.users)) delete data.users[id];
    data.users.r1 = { user: encrypt('p.nom'), pass: encrypt('x') };
    const deadline = now + 20 * 3_600_000;
    Object.assign(store.getUserAlerts(data, 'r1'), {
        grades: false, absences: false, agenda: false, digest: false,
        reminded: { '7777|1|86400000': deadline }, // déjà envoyé par une version précédente
    });
    store.saveData(data);

    const sent = [];
    const client = { users: { fetch: async () => ({ send: async (p) => sent.push(p) }) } };
    const projects = [
        { project_id: 7777, name: 'Déjà rappelé', steps: [{ psp_id: 1, psp_limit_date: deadline, psp_type: 'Rendu' }] },
        { project_id: 8888, name: 'Nouveau', steps: [{ psp_id: 2, psp_limit_date: deadline, psp_type: 'Rendu' }] },
    ];
    mockFetch([
        new Response(null, { status: 302, headers: { location: 'x:/#access_token=t&token_type=bearer&expires_in=86400' } }),
        json(200, { result: projects }), json(200, { result: [] }),
    ]);
    await runPersonalCheck(client);

    assert.strictEqual(sent.length, 1);
    assert.match(sent[0].embeds[0].data.description, /Nouveau/);
    const alerts = store.loadData().alerts.r1;
    assert.strictEqual(alerts.reminded, undefined);
    assert.ok(alerts.remindedSnapshot);
    const stored = JSON.stringify(alerts);
    assert.ok(!stored.includes('7777') && !stored.includes('8888') && !stored.includes(String(deadline)));
});

test('liens masqués : un texte MyGes ne peut pas déguiser un lien', () => {
    const { md } = dist('utils/markdown.js');
    assert.doesNotMatch(md('[Dépose ton rendu](https://faux.example)'), /^\[Dépose ton rendu\]\(https/);
});

test('/config : droits revérifiés à chaque action', () => {
    const { mayConfigure } = dist('commands/config.js');
    const perms = (admin) => ({ has: () => admin });
    assert.strictEqual(mayConfigure(perms(true), '1'), true);
    assert.strictEqual(mayConfigure(perms(false), '1'), false);
    assert.strictEqual(mayConfigure(null, '1'), false);
});

test('nom de fichier : un contrôle bidirectionnel ne déguise pas l\'extension', () => {
    const { safeFileName } = dist('utils/documents.js');
    assert.doesNotMatch(safeFileName('consigne\u202Efdp.exe'), /\u202E/);
    assert.doesNotMatch(safeFileName('a\u200Fb.pdf'), /\u200F/);
});

test('journal : une séquence d\'échappement ne passe pas', (t) => {
    const { log } = dist('utils/logger.js');
    const lines = [];
    t.mock.method(console, 'log', (l) => lines.push(l));
    log('PROJET', 'nom\u001b[2Jfin');
    assert.doesNotMatch(lines[0], /\u001b/);
});

test('aucun propriétaire codé en dur dans le dépôt public', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'config.ts'), 'utf-8');
    assert.doesNotMatch(source, /\d{17,}/);
});

test('OWNER_IDS vide : aucun propriétaire, pas de repli sur la valeur par défaut', () => {
    const script = `const {isBotOwner}=require(${JSON.stringify(path.join(__dirname, '..', 'dist', 'config.js'))});` +
        `process.stdout.write(String([isBotOwner('111'),isBotOwner('42')]));`;
    const run = (OWNER_IDS) => spawnSync(process.execPath, ['-e', script], { env: { ...process.env, OWNER_IDS }, encoding: 'utf-8' }).stdout;
    assert.strictEqual(run(''), 'false,false');
    assert.strictEqual(run('42'), 'false,true');
});
