const test = require('node:test');
const assert = require('node:assert');
const { dist, mockFetch, redirect, json } = require('./helpers');

const store = dist('core/store.js');
const { encrypt } = dist('crypto.js');

const OK_LOCATION = 'comreseaugesskolae:/oauth2redirect#access_token=abc+def&token_type=bearer&expires_in=3600';

function register(userId) {
    const data = store.loadData();
    data.users[userId] = { user: encrypt('p.nom'), pass: encrypt('secret') };
    store.saveData(data);
}

test('une session est rétablie à la demande, en une seule connexion', async () => {
    register('u1');
    const calls = mockFetch([redirect(OK_LOCATION)]);
    const [a, b] = await Promise.all([store.getSession('u1'), store.getSession('u1')]);
    assert.ok(a);
    assert.strictEqual(a, b);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(a.access_token, 'abc+def'); // token gardé brut, « + » compris
});

test('identifiants refusés : plus aucune tentative avant un nouveau /login', async () => {
    register('u2');
    const calls = mockFetch([json(401, {})]);
    assert.strictEqual(await store.getSession('u2'), null);
    assert.strictEqual(store.loginFailure('u2'), 'bad-credentials');
    assert.strictEqual(await store.getSession('u2'), null);
    assert.strictEqual(calls.length, 1); // pas de second essai : risque de verrouillage du compte
});

test('MyGes en panne (5xx) n\'est pas pris pour un mauvais mot de passe', async () => {
    register('u3');
    mockFetch([json(503, {})]);
    assert.strictEqual(await store.getSession('u3'), null);
    assert.strictEqual(store.loginFailure('u3'), 'unavailable');
});

test('sans compte enregistré, aucune connexion n\'est tentée', async () => {
    const calls = mockFetch([]);
    assert.strictEqual(await store.getSession('inconnu'), null);
    assert.strictEqual(calls.length, 0);
});
