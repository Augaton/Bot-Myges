// Réponses atypiques de MyGes : corps vide, refus du pare-feu, texte HTML.
const test = require('node:test');
const assert = require('node:assert');
const { dist, mockFetch, json } = require('./helpers');

const store = dist('core/store.js');
const { encrypt } = dist('crypto.js');
const { BaseService } = dist('myges/services/base.js');
const { AuthService } = dist('myges/services/auth.js');
const { BadCredentialsError, MyGesError } = dist('myges/errors.js');
const { snippet } = dist('utils/format.js');

const creds = { token_type: 'bearer', access_token: 't' };

test('204 sans corps : la lecture renvoie null au lieu de planter', async () => {
    mockFetch([new Response(null, { status: 204 })]);
    assert.strictEqual(await BaseService.request(creds, 'GET', '/me/2026/absences'), null);
});

test('authentification : 401 signifie identifiants refusés', async () => {
    mockFetch([json(401, {})]);
    await assert.rejects(AuthService.generateAccessToken('p.nom', 'x'), BadCredentialsError);
});

test('authentification : un 403 du pare-feu n\'est pas un mauvais mot de passe', async () => {
    mockFetch([json(403, {})]);
    await assert.rejects(AuthService.generateAccessToken('p.nom', 'x'), (e) => e instanceof MyGesError && e.status === 403);
});

test('un 403 ne bloque pas le compte jusqu\'au prochain /login', async () => {
    const data = store.loadData();
    data.users.firewall = { user: encrypt('p.nom'), pass: encrypt('secret') };
    store.saveData(data);
    mockFetch([json(403, {})]);
    assert.strictEqual(await store.getSession('firewall'), null);
    assert.strictEqual(store.loginFailure('firewall'), 'unavailable');
});

test('snippet : les accents HTML sont décodés, pas remplacés par des espaces', () => {
    assert.strictEqual(snippet('<p>Activit&eacute; d&#39;&eacute;t&eacute;&nbsp;: 5&euro;</p>'), "Activité d'été : 5€");
    assert.strictEqual(snippet('A &amp; B &#x2013; C'), 'A & B – C');
    assert.strictEqual(snippet('&inconnue; fin'), 'fin');
});

test('snippet : une balise encodée reste du texte', () => {
    assert.strictEqual(snippet('&lt;b&gt;gras&lt;/b&gt;'), '<b>gras</b>');
});

test('paragraphs : garde les paragraphes, ôte le HTML, ne laisse ni espaces ni lignes en trop', () => {
    const { paragraphs } = dist('utils/format.js');
    assert.strictEqual(paragraphs('<p>Un  <b>texte</b></p><p>Deux</p>'), 'Un texte \nDeux'.replace(' \n', '\n'));
    assert.strictEqual(paragraphs('a<br>b<br/><br /><br>c'), 'a\nb\n\nc');
    assert.strictEqual(paragraphs('a\r\n  b\n\n\n\nc'), 'a\nb\n\nc');
    assert.strictEqual(paragraphs('&lt;b&gt; reste du texte'), '<b> reste du texte');
    assert.strictEqual(paragraphs('x'.repeat(50), 10).length, 10);
    assert.strictEqual(paragraphs(''), '');
    assert.strictEqual(paragraphs(undefined), '');
    assert.strictEqual(paragraphs(12), '12');
    const started = Date.now();
    paragraphs('<'.repeat(200_000));
    paragraphs(`\n${' '.repeat(200_000)}\n`);
    assert.ok(Date.now() - started < 2_000);
});

test('snippet : garde une seule ligne, et un champ qui n\'est pas du texte ne plante plus', () => {
    assert.strictEqual(snippet('<p>Un</p><p>Deux</p><br>Trois'), 'Un Deux Trois');
    assert.strictEqual(snippet(12), '12');
    assert.strictEqual(snippet({}), '[object Object]');
});
