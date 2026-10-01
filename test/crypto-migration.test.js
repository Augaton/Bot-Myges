// Migration du chiffrement : les identifiants à l'ancien format (clé brute)
// sont rechiffrés avec la clé dérivée par scrypt, avec copie de sauvegarde.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { dist } = require('./helpers');

const RAW_KEY = Buffer.from(process.env.ENCRYPTION_KEY);

function legacyGcm(text) {
    const iv = crypto.randomBytes(16);
    const c = crypto.createCipheriv('aes-256-gcm', RAW_KEY, iv);
    const content = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return { iv: iv.toString('hex'), content: content.toString('hex'), tag: c.getAuthTag().toString('hex') };
}
function legacyCbc(text) {
    const iv = crypto.randomBytes(16);
    const c = crypto.createCipheriv('aes-256-cbc', RAW_KEY, iv);
    return { iv: iv.toString('hex'), content: Buffer.concat([c.update(text, 'utf8'), c.final()]).toString('hex') };
}

// Fichier au format v3.3 écrit AVANT le chargement du store.
fs.writeFileSync(process.env.DB_FILE, JSON.stringify({
    users: {
        gcm: { user: legacyGcm('p.gcm'), pass: legacyGcm('mdp é') },
        cbc: { user: legacyCbc('p.cbc'), pass: legacyCbc('vieux') },
        casse: { user: { iv: '00', content: '00', tag: '00' }, pass: legacyCbc('x') },
    },
    guilds: { g1: { knownProjectIds: [1] } },
}));

const store = dist('core/store.js');
const { decrypt, encrypt, fingerprint } = dist('crypto.js');

test('les anciens identifiants sont migrés vers la clé dérivée, sans perte', () => {
    const { users, crypto: kdf, guilds } = store.loadData();
    assert.strictEqual(kdf.algo, 'scrypt');
    assert.strictEqual(users.gcm.user.v, 2);
    assert.strictEqual(decrypt(users.gcm.pass), 'mdp é');
    assert.strictEqual(users.cbc.pass.v, 2);
    assert.strictEqual(decrypt(users.cbc.user), 'p.cbc');
    assert.deepStrictEqual(guilds.g1.knownProjectIds, [1]);

    // Persisté sur disque, au nouveau format.
    const onDisk = JSON.parse(fs.readFileSync(process.env.DB_FILE, 'utf-8'));
    assert.strictEqual(onDisk.users.gcm.user.v, 2);
});

test('un identifiant illisible est laissé tel quel, pas supprimé', () => {
    assert.ok(store.loadData().users.casse);
    assert.strictEqual(store.loadData().users.casse.user.v, undefined);
});

test('une copie du fichier d\'origine est conservée (retour arrière possible)', () => {
    const backup = JSON.parse(fs.readFileSync(`${process.env.DB_FILE}.bak-avant-scrypt`, 'utf-8'));
    assert.strictEqual(backup.users.gcm.user.v, undefined);
    assert.strictEqual((fs.statSync(`${process.env.DB_FILE}.bak-avant-scrypt`).mode & 0o777), 0o600);
});

test('format courant : IV de 12 octets, aller-retour, empreintes stables', () => {
    const enc = encrypt('secret');
    assert.strictEqual(enc.v, 2);
    assert.strictEqual(Buffer.from(enc.iv, 'hex').length, 12);
    assert.strictEqual(decrypt(enc), 'secret');
    assert.strictEqual(fingerprint('T1|Anglais|cc|0|15'), fingerprint('T1|Anglais|cc|0|15'));
    assert.notStrictEqual(fingerprint('T1|Anglais|cc|0|15'), fingerprint('T1|Anglais|cc|0|16'));
});
