const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { dist } = require('./helpers');

test('le bot vit à l\'heure de Paris, même sur un serveur en UTC', () => {
    // Processus séparé : le fuseau de départ doit vraiment être UTC.
    const script = `require(${JSON.stringify(path.join(__dirname, '..', 'dist', 'config.js'))});` +
        `process.stdout.write(String(new Date('2026-09-28T07:00:00Z').getHours()));`;
    const out = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: 'UTC' }, encoding: 'utf-8' });
    assert.strictEqual(out.status, 0, out.stderr);
    assert.strictEqual(out.stdout, '9'); // 07:00 UTC = 09:00 à Paris (heure d'été)
});

test('le propriétaire du bot est reconnu, et lui seul', () => {
    const { isBotOwner } = dist('config.js');
    assert.strictEqual(isBotOwner('456653480048852995'), true);
    assert.strictEqual(isBotOwner('123456789012345678'), false);
});

test('la version affichée suit package.json', () => {
    const { BOT_VERSION } = dist('config.js');
    assert.strictEqual(BOT_VERSION, `v${require('../package.json').version}`);
});
