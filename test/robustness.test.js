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
