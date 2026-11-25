// Documents : lecture des réponses MyGes et téléchargement borné (servis par le panel).
const test = require('node:test');
const assert = require('node:assert');
const { dist, mockFetch, json } = require('./helpers');

const { BaseService } = dist('myges/services/base.js');
const { FileTooLargeError, MyGesError } = dist('myges/errors.js');
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
