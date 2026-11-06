// /documents : lecture des réponses MyGes, téléchargement borné, parcours complet.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { dist, mockFetch, json } = require('./helpers');

const { BaseService } = dist('myges/services/base.js');
const { FileTooLargeError, MyGesError } = dist('myges/errors.js');
const store = dist('core/store.js');
const { encrypt } = dist('crypto.js');
const documents = dist('commands/documents.js');
const { acquireDownload, courseSources, releaseDownload, safeFileName, toDocuments } = dist('utils/documents.js');

const creds = { token_type: 'bearer', access_token: 't' };
const file = (body, headers = {}) => new Response(body, { status: 200, headers });

test('supports de cours : format Kordis, du plus récent au plus ancien', () => {
    const docs = toDocuments([
        { oc_id: 1, label: 'Ancien', extension: '.pdf', update_date: 1000 },
        { oc_id: 2, label: 'fiche listes chain&eacute;es', extension: '.pdf', update_date: 2000 },
        { label: 'sans identifiant' },
    ]);
    assert.deepStrictEqual(docs.map((d) => [d.id, d.title, d.fileName]), [
        ['2', 'fiche listes chainées', 'fiche listes chainées.pdf'],
        ['1', 'Ancien', 'Ancien.pdf'],
    ]);
});

test('documents administratifs : tableau seul ou { annualDocuments, documents }', () => {
    const nested = toDocuments({
        annualDocuments: [{ id: 'a', filename: 'certificat.pdf', extension: 'pdf' }],
        documents: [{ id: 'b', title: 'Bulletin', extension: 'application/zip' }],
    });
    assert.deepStrictEqual(nested.map((d) => d.fileName).sort(), ['Bulletin', 'certificat.pdf']);
    assert.deepStrictEqual(toDocuments(null), []);
    assert.deepStrictEqual(toDocuments({ inattendu: true }), []);
});

test('matières : celles qui ont des documents d\'abord, sans doublon', () => {
    const sources = courseSources([
        { rc_id: 1, name: 'T1 - Anglais', has_documents: null, trimester_name: 'Semestre 1' },
        { rc_id: 2, name: 'T1 - Web', has_documents: true },
        { rc_id: 2, name: 'T1 - Web', has_documents: true },
        { name: 'sans identifiant' },
    ]);
    assert.deepStrictEqual(sources.map((s) => [s.id, s.name, s.hint]), [['2', 'Web', ''], ['1', 'Anglais', 'Semestre 1']]);
    assert.deepStrictEqual(courseSources(null), []);
});

test('format réel de MyGes : semestre des matières, sans celles qui n\'ont aucun document', () => {
    const sources = courseSources([
        { rc_id: 1, name: 'T1 - Anglais', has_documents: false, trimester: 'Semestre 1' },
        { rc_id: 2, name: 'T1 - Web', has_documents: true, trimester: 'Semestre 1', teacher: 'M. Martin' },
    ]);
    assert.deepStrictEqual(sources.map((s) => [s.id, s.hint]), [['2', 'Semestre 1']]);
});

test('format réel de MyGes : documents annuels avec leur catégorie', () => {
    const [doc] = toDocuments([{ category: 'INFORMATIONS GENERALES', document_id: 9, extension: '.pdf', filename: 'guide', last_update: 2000, name: 'Guide de rentrée' }]);
    assert.deepStrictEqual(doc, { id: '9', title: 'Guide de rentrée', fileName: 'guide.pdf', date: 2000, category: 'Informations generales' });
});

test('nom de fichier : ni dossier, ni caractère de contrôle, extension conservée', () => {
    assert.strictEqual(safeFileName('../../etc/passwd'), 'etc passwd');
    assert.strictEqual(safeFileName('a\u0000b\r\n.pdf'), 'a b .pdf');
    assert.strictEqual(safeFileName('...'), 'document');
    assert.ok(safeFileName(`${'x'.repeat(300)}.pdf`).endsWith('.pdf'));
    assert.strictEqual(safeFileName(`${'x'.repeat(300)}.pdf`).length, 100);
});

test('téléchargement : contenu et nom annoncé, y compris encodé', async () => {
    mockFetch([file('%PDF', { 'content-type': 'application/pdf', 'content-disposition': "attachment; filename*=UTF-8''cours%20r%C3%A9seau.pdf" })]);
    const got = await BaseService.download(creds, '/me/1/files/2', 100);
    assert.strictEqual(got.data.toString(), '%PDF');
    assert.strictEqual(got.fileName, 'cours réseau.pdf');

    mockFetch([file('%PDF', { 'content-disposition': 'attachment; filename="tp.pdf"' })]);
    assert.strictEqual((await BaseService.download(creds, '/x', 100)).fileName, 'tp.pdf');
});

test('téléchargement : une page de connexion n\'est pas un fichier', async () => {
    mockFetch([file('<html>', { 'content-type': 'text/html;charset=UTF-8' })]);
    await assert.rejects(BaseService.download(creds, '/x', 100), MyGesError);
});

test('téléchargement : fichier vide refusé', async () => {
    mockFetch([new Response(null, { status: 204 })]);
    await assert.rejects(BaseService.download(creds, '/x', 100), MyGesError);
});

test('téléchargement : la limite vaut pour la taille annoncée et pour la taille réelle', async () => {
    mockFetch([file('x', { 'content-length': '101' })]);
    await assert.rejects(BaseService.download(creds, '/x', 100), FileTooLargeError);
    mockFetch([file('x'.repeat(101))]); // taille non annoncée
    await assert.rejects(BaseService.download(creds, '/x', 100), FileTooLargeError);
});

test('téléchargement : un token expiré est renouvelé comme pour une lecture', async () => {
    const calls = mockFetch([json(401, {}), file('ok')]);
    const c = { ...creds, __refresh: async () => ({ token_type: 'bearer', access_token: 'neuf' }) };
    assert.strictEqual((await BaseService.download(c, '/x', 100)).data.toString(), 'ok');
    assert.strictEqual(calls[1].init.headers.Authorization, 'bearer neuf');
});

test('téléchargements : un seul à la fois par personne, plafond global', () => {
    assert.strictEqual(acquireDownload('a'), null);
    assert.match(acquireDownload('a'), /déjà en cours/);
    assert.strictEqual(acquireDownload('b'), null);
    assert.strictEqual(acquireDownload('c'), null);
    assert.match(acquireDownload('d'), /Trop de téléchargements/);
    for (const u of ['a', 'b', 'c']) releaseDownload(u);
    assert.strictEqual(acquireDownload('d'), null);
    releaseDownload('d');
});

/** Exécute la commande avec un faux Discord ; les composants passent par le validateur de discord.js. */
async function openCommand(userId) {
    const replies = [];
    const followUps = [];
    const collector = Object.assign(new EventEmitter(), { resetTimer() {} });
    const interaction = {
        user: { id: userId },
        deferReply: async () => {},
        editReply: async (reply) => {
            replies.push(typeof reply === 'string' ? reply : { ...reply, components: reply.components?.map((r) => r.toJSON()) });
            return { createMessageComponentCollector: () => collector };
        },
    };
    await documents.default.execute(interaction);
    const pick = async (customId, value) => {
        const done = new Promise((resolve) => {
            collector.emit('collect', {
                customId,
                values: [value],
                user: { id: userId },
                attachmentSizeLimit: 1024,
                deferUpdate: async () => {},
                followUp: async (payload) => followUps.push(payload),
            });
            setImmediate(resolve);
        });
        await done;
        await new Promise((resolve) => setTimeout(resolve, 20));
    };
    return { replies, followUps, pick };
}

test('/documents : matière, liste des fichiers, puis fichier reçu en privé', async () => {
    const data = store.loadData();
    data.users.doc1 = { user: encrypt('p.nom'), pass: encrypt('secret') };
    store.saveData(data);

    const calls = mockFetch([
        new Response(null, { status: 302, headers: { location: 'x:/#access_token=t&token_type=bearer&expires_in=86400' } }),
        json(200, { result: [{ rc_id: 42, name: 'T1 - Réseaux', has_documents: true }] }),
        json(200, { result: [{ oc_id: 7, label: 'Cours 1', extension: '.pdf', update_date: 1776702686256 }] }),
        file('%PDF', { 'content-type': 'application/pdf' }),
    ]);
    const { replies, followUps, pick } = await openCommand('doc1');
    const menu = (reply, row = 0) => reply.components[row].components[0];
    assert.deepStrictEqual(menu(replies.at(-1)).options.map((o) => o.value), ['annual', '42']);
    assert.strictEqual(menu(replies.at(-1)).options[0].label, 'Documents annuels');

    await pick('doc_source', '42');
    assert.ok(calls.at(-1).url.endsWith('/me/42/files'));
    assert.deepStrictEqual(menu(replies.at(-1), 1).options.map((o) => o.label), ['Cours 1']);

    await pick('doc_file', '7');
    assert.ok(calls.at(-1).url.endsWith('/me/42/files/7'));
    assert.strictEqual(followUps.length, 1);
    assert.strictEqual(followUps[0].files[0].name, 'Cours 1.pdf');
    assert.ok(followUps[0].flags); // jamais public
});

test('/documents : erreur, liste vide et fichier trop lourd donnent un message clair', async () => {
    mockFetch([
        json(200, { result: [{ rc_id: 42, name: 'Réseaux' }] }),
        json(404, {}),
        new Response(null, { status: 204 }),
        json(200, { result: [{ oc_id: 7, label: 'Lourd' }] }),
        file('x', { 'content-length': '2048' }),
    ]);
    const { replies, followUps, pick } = await openCommand('doc1');

    await pick('doc_source', 'annual');
    assert.match(replies.at(-1).embeds[0].data.description, /Impossible de récupérer ces documents/);

    await pick('doc_source', '42');
    assert.match(replies.at(-1).embeds[0].data.description, /Aucun document pour \*\*Réseaux\*\*/);
    assert.strictEqual(replies.at(-1).components.length, 1); // pas de menu de fichiers vide

    await pick('doc_source', 'annual'); // entrée simulée : l'API renvoie 200 avec un fichier
    await pick('doc_file', '7');
    assert.match(followUps[0].content, /dépasse/);
});
