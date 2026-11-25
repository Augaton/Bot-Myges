// Commandes du bot : la liste enregistrée, /help (état, nouveautés) et le prochain cours de /agenda.
const test = require('node:test');
const assert = require('node:assert');
const { dist, json } = require('./helpers');

const quiet = (t) => {
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', () => {});
};

test('commandes enregistrées : les 8 des étudiants, puis /config et /serveurs', () => {
    const { commands, commandsJSON } = dist('core/registry.js');
    assert.deepStrictEqual(commandsJSON.map((c) => c.name), ['login', 'logout', 'panel', 'agenda', 'notes', 'alertes', 'campus', 'help', 'config', 'serveurs']);
    for (const removed of ['prochain', 'abonnement', 'ping', 'changelog', 'absences', 'projets', 'documents', 'export', 'profil', 'profs', 'trombi', 'news']) {
        assert.strictEqual(commands.get(removed), undefined, removed);
    }
});

/** Lance /help avec un faux Discord ; renvoie la réponse. */
async function help() {
    const command = dist('commands/help.js').default;
    const replies = [];
    await command.execute({ client: { user: null }, deferReply: async () => {}, editReply: async (r) => replies.push(r) });
    return replies.at(-1);
}

test('/help : état de MyGES gardé une minute, bouton « Nouveautés » et partage ; aucune commande retirée citée', async (t) => {
    quiet(t);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    let asked = 0;
    globalThis.fetch = async () => { asked++; return new Response(null, { status: 401 }); }; // le serveur répond : en ligne
    let reply = await help();
    const fields = reply.embeds[0].toJSON().fields;
    assert.match(fields.find((f) => /État/.test(f.name)).value, /MyGES : 🟢 en ligne \(\d+ ms\)/);
    assert.deepStrictEqual(reply.components[0].toJSON().components.map((b) => b.custom_id), ['help:nouveautes', 'share_public']);
    const text = JSON.stringify(fields);
    for (const removed of ['/prochain', '/abonnement', '/ping', '/changelog', '/absences', '/projets', '/documents', '/export', '/profil', '/profs', '/trombi', '/news', '/serveurs']) {
        assert.ok(!text.includes(removed), removed);
    }

    await help();
    assert.strictEqual(asked, 1, 'Kordis interrogé une fois par minute au plus');

    t.mock.timers.tick(61_000);
    globalThis.fetch = async () => new Response(null, { status: 503 });
    reply = await help();
    assert.match(JSON.stringify(reply.embeds[0].toJSON().fields), /instable \(erreur 503\)/);

    t.mock.timers.tick(61_000);
    globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
    reply = await help();
    assert.match(JSON.stringify(reply.embeds[0].toJSON().fields), /ne répond pas/);
});

test('bouton « Nouveautés » : le changelog, visible par l\'étudiant seul et partageable', async () => {
    const { handleHelpButton } = dist('commands/help.js');
    const replies = [];
    await handleHelpButton({ client: { user: null }, reply: async (r) => replies.push(r) });
    const reply = replies.at(-1);
    assert.ok(reply.flags);
    assert.match(reply.embeds[0].toJSON().title, /Mise à jour/);
    assert.deepStrictEqual(reply.components[0].toJSON().components.map((b) => b.custom_id), ['share_public']);
});

test('/agenda, prochain cours : le premier à venir, nom échappé, salle et campus ; rien s\'il n\'y en a pas', async () => {
    const { nextCourseLine } = dist('commands/agenda.js');
    const token = { token_type: 'bearer', access_token: 't' };
    const now = Date.now();
    const hour = 3_600_000;
    const course = (name, start, rooms = []) => ({ reservation_id: start, name, start_date: start, end_date: start + 2 * hour, rooms });
    globalThis.fetch = async (url) => (String(url).includes('/agenda')
        ? json(200, { result: [
            course('Passé', now - hour),
            course('Plus tard', now + 30 * hour),
            course('T1 - Réseaux *avancés*', now + 3 * hour, [{ name: 'Salle 12', campus: 'NATION1' }]),
        ] })
        : json(200, { result: [] }));
    const line = await nextCourseLine('prochain-1', token, now);
    const at = Math.floor((now + 3 * hour) / 1000);
    assert.strictEqual(line, `⏭️ Prochain cours : **Réseaux \\*avancés\\***, <t:${at}:f> (<t:${at}:R>) · Salle 12 (Nation 1)`);

    globalThis.fetch = async () => json(200, { result: [course('Passé', now - hour)] });
    assert.strictEqual(await nextCourseLine('prochain-2', token, now), null);
});
