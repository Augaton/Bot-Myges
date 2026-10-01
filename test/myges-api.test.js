const test = require('node:test');
const assert = require('node:assert');
const { dist, mockFetch, json } = require('./helpers');

const { BaseService } = dist('myges/services/base.js');
const { MyGesError } = dist('myges/errors.js');

const creds = (extra = {}) => ({ token_type: 'bearer', access_token: 'old', ...extra });

test('une erreur 500 passagère est rejouée sur une lecture', async () => {
    const calls = mockFetch([json(500, {}), json(502, {}), json(200, { result: [1, 2] })]);
    assert.deepStrictEqual(await BaseService.request(creds(), 'GET', '/me/x'), [1, 2]);
    assert.strictEqual(calls.length, 3);
});

test('une erreur 500 persistante remonte une MyGesError avec son statut', async () => {
    mockFetch([json(500, {}), json(500, {}), json(500, {})]);
    await assert.rejects(BaseService.request(creds(), 'GET', '/me/x'), (e) => e instanceof MyGesError && e.status === 500);
});

test('une écriture (POST) n\'est jamais rejouée', async () => {
    const calls = mockFetch([json(500, {})]);
    await assert.rejects(BaseService.request(creds(), 'POST', '/me/x', { body: {} }), MyGesError);
    assert.strictEqual(calls.length, 1);
});

test('401 : le token est renouvelé puis la requête rejouée', async () => {
    const calls = mockFetch([json(401, {}), json(200, { result: 'ok' })]);
    let refreshes = 0;
    const c = creds({ __refresh: async () => (refreshes++, { token_type: 'bearer', access_token: 'new' }) });
    assert.strictEqual(await BaseService.request(c, 'GET', '/me/x'), 'ok');
    assert.strictEqual(refreshes, 1);
    assert.strictEqual(calls[1].init.headers.Authorization, 'bearer new');
});

test('un token sur le point d\'expirer est renouvelé avant l\'appel', async () => {
    const calls = mockFetch([json(200, { result: 'ok' })]);
    const c = creds({
        expires_at: Date.now() + 10_000,
        __refresh: async () => ({ token_type: 'bearer', access_token: 'new', expires_at: Date.now() + 3_600_000 }),
    });
    await BaseService.request(c, 'GET', '/me/x');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].init.headers.Authorization, 'bearer new');
});
