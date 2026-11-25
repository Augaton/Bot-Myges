// Commandes du bot : la liste enregistrée, /help (état, nouveautés), le prochain cours de /agenda et le tableau de bord.
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

// --- Tableau de bord (core/hub) ---

const ids = (message) => message.components.map((row) => row.toJSON().components.map((b) => b.custom_id));

test('tableau de bord : un bouton par commande étudiante, jamais /config ni /serveurs ; Panel seulement avec une adresse publique', () => {
    const { hubCommand, hubMessage } = dist('core/hub.js');
    assert.strictEqual(hubCommand('hub:agenda'), 'agenda');
    for (const refused of ['hub:config', 'hub:serveurs', 'hub:', 'agenda', 'share_public', 'hub:agenda:x']) {
        assert.strictEqual(hubCommand(refused), null, refused);
    }

    const before = process.env.PANEL_PUBLIC_URL;
    try {
        process.env.PANEL_PUBLIC_URL = 'https://panel.example:8443';
        let message = hubMessage({ user: null });
        assert.deepStrictEqual(ids(message), [['hub:login', 'hub:agenda', 'hub:notes', 'hub:panel'], ['hub:alertes', 'hub:campus', 'hub:help', 'hub:logout']]);
        assert.match(message.embeds[0].toJSON().description, /Panel/);
        assert.deepStrictEqual(message.allowedMentions, { parse: [] });
        const { commands } = dist('core/registry.js');
        for (const id of ids(message).flat()) assert.ok(commands.get(hubCommand(id)), id);

        delete process.env.PANEL_PUBLIC_URL;
        message = hubMessage({ user: null });
        assert.ok(!ids(message).flat().includes('hub:panel'));
        assert.doesNotMatch(message.embeds[0].toJSON().description, /Panel/);
    } finally {
        if (before === undefined) delete process.env.PANEL_PUBLIC_URL;
        else process.env.PANEL_PUBLIC_URL = before;
    }
});

/** Faux Discord : salons dont on note les messages envoyés, modifiés, supprimés. */
function fakeDiscord() {
    const log = [];
    let next = 1;
    const channel = (id, { sendable = true, gone = false } = {}) => ({
        id,
        isSendable: () => sendable,
        isTextBased: () => true,
        send: async () => { const m = { id: `m${next++}` }; log.push(['send', id, m.id]); return m; },
        messages: {
            delete: async (m) => { if (gone) throw Object.assign(new Error('Unknown Message'), { code: 10008 }); log.push(['delete', id, m]); },
            edit: async (m) => { if (gone) throw Object.assign(new Error('Unknown Message'), { code: 10008 }); log.push(['edit', id, m]); },
        },
    });
    const channels = { c1: channel('c1'), c2: channel('c2'), ro: channel('ro', { sendable: false }), gone: channel('gone', { gone: true }) };
    const fetch = async (id) => channels[id] ?? null;
    const client = { user: null, channels: { fetch } };
    const guild = { id: 'g-hub', name: 'Promo', client, channels: { fetch } };
    return { log, client, guild };
}

test('tableau de bord : publié en bas, l\'ancien retiré après coup ; un échec garde l\'ancien ; « Retirer » efface tout', async (t) => {
    quiet(t);
    const { publishHub, removeHub } = dist('core/hub.js');
    const { log, client, guild } = fakeDiscord();
    const cfg = { knownProjectIds: [] };

    assert.strictEqual(await publishHub(guild, cfg, 'c1'), null);
    assert.deepStrictEqual([cfg.hubChannelId, cfg.hubMessageId], ['c1', 'm1']);

    assert.strictEqual(await publishHub(guild, cfg, 'c2'), null);
    assert.deepStrictEqual(log, [['send', 'c1', 'm1'], ['send', 'c2', 'm2'], ['delete', 'c1', 'm1']]);
    assert.deepStrictEqual([cfg.hubChannelId, cfg.hubMessageId], ['c2', 'm2']);

    assert.match(await publishHub(guild, cfg, 'ro'), /introuvable|sans messages/);
    assert.match(await publishHub(guild, cfg, 'absent'), /introuvable/);
    assert.deepStrictEqual([cfg.hubChannelId, cfg.hubMessageId], ['c2', 'm2'], 'le tableau en place reste rattaché');

    await removeHub(client, cfg);
    assert.deepStrictEqual(log.at(-1), ['delete', 'c2', 'm2']);
    assert.strictEqual(cfg.hubChannelId, undefined);
    assert.strictEqual(cfg.hubMessageId, undefined);

    // Message déjà supprimé à la main : rien à signaler, le réglage est effacé quand même.
    const manual = { knownProjectIds: [], hubChannelId: 'gone', hubMessageId: 'm9' };
    await removeHub(client, manual);
    assert.strictEqual(manual.hubMessageId, undefined);
});

test('tableau de bord au démarrage : remis à jour, ou oublié s\'il a été supprimé à la main', async (t) => {
    quiet(t);
    const { refreshHubs } = dist('core/hub.js');
    const { loadData } = dist('core/store.js');
    const { log, client } = fakeDiscord();
    const data = loadData();
    data.guilds['g-live'] = { knownProjectIds: [], hubChannelId: 'c1', hubMessageId: 'm5' };
    data.guilds['g-gone'] = { knownProjectIds: [], hubChannelId: 'gone', hubMessageId: 'm6' };
    await refreshHubs(client);
    assert.deepStrictEqual(log, [['edit', 'c1', 'm5']]);
    assert.strictEqual(data.guilds['g-live'].hubMessageId, 'm5');
    assert.strictEqual(data.guilds['g-gone'].hubMessageId, undefined);
    delete data.guilds['g-live'];
    delete data.guilds['g-gone'];
});

/** Faux clic sur un bouton : ce qu'il a répondu ou remplacé. */
function click(customId, userId) {
    const out = { replies: [], updates: [], edits: [] };
    const i = {
        customId,
        user: { id: userId, tag: 'x', displayAvatarURL: () => 'https://cdn.discordapp.com/a.png' },
        client: { user: null },
        isButton: () => true,
        isChatInputCommand: () => false,
        reply: async (r) => out.replies.push(r),
        update: async (r) => out.updates.push(r),
        deferReply: async () => {},
        editReply: async (r) => out.edits.push(r),
    };
    return { i, out };
}

test('se déconnecter depuis le tableau de bord : une confirmation d\'abord, puis tout est effacé', async (t) => {
    quiet(t);
    const logout = dist('commands/logout.js');
    const { loadData, saveData, hasAccount } = dist('core/store.js');
    const { encrypt } = dist('crypto.js');
    const data = loadData();
    data.users['u-hub'] = { user: encrypt('p.nom'), pass: encrypt('secret') };
    saveData(data);

    let { i, out } = click('hub:logout', 'u-hub');
    await logout.default.execute(i);
    assert.ok(hasAccount('u-hub'), 'rien n\'est effacé sans confirmation');
    assert.ok(out.replies[0].flags);
    assert.deepStrictEqual(out.replies[0].components[0].toJSON().components.map((b) => b.custom_id), [logout.LOGOUT_CONFIRM_ID]);

    ({ i, out } = click(logout.LOGOUT_CONFIRM_ID, 'u-hub'));
    await logout.default.execute(i);
    assert.ok(!hasAccount('u-hub'));
    assert.deepStrictEqual(out.updates[0].components, [], 'la confirmation est remplacée, sans bouton');
    assert.match(out.updates[0].embeds[0].toJSON().title, /Déconnexion réussie/);
});

test('pas encore connecté : depuis un bouton, /notes et /alertes proposent « Se connecter »', async (t) => {
    quiet(t);
    const loginRow = (r) => r.components.map((row) => row.toJSON().components.map((b) => b.custom_id));

    let { i, out } = click('hub:notes', 'u-inconnu');
    await dist('commands/notes.js').default.execute(i);
    assert.match(out.edits[0].content, /Connecte-toi/);
    assert.deepStrictEqual(loginRow(out.edits[0]), [['hub:login']]);

    ({ i, out } = click('hub:alertes', 'u-inconnu'));
    await dist('commands/alertes.js').default.execute(i);
    assert.deepStrictEqual(loginRow(out.replies[0]), [['hub:login']]);
    assert.ok(out.replies[0].flags);
});
