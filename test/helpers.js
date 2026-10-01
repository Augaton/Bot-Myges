// Prépare un environnement isolé AVANT de charger le code du bot : base de
// données temporaire et clé de chiffrement de test (prioritaires sur le .env).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botmyges-test-'));
process.env.DB_FILE = path.join(dir, 'saved_data.json');
process.env.CAMPUS_FILE = path.join(dir, 'campus.json');
process.env.ENCRYPTION_KEY = 'test-key-0123456789abcdef0123456';
process.env.OWNER_IDS = '';

const dist = (p) => require(path.join(__dirname, '..', 'dist', p));

/** Remplace fetch par une suite de réponses scriptées ; renvoie les appels reçus. */
function mockFetch(responses) {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        const next = responses.shift();
        if (!next) throw new Error(`fetch inattendu : ${url}`);
        if (next instanceof Error) throw next;
        return next;
    };
    return calls;
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const redirect = (location) => new Response(null, { status: 302, headers: { location } });

module.exports = { dist, mockFetch, json, redirect };
