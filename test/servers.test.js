// /serveurs : où est le bot, en lecture seule, pour son seul propriétaire.
const test = require('node:test');
const assert = require('node:assert');
const { dist } = require('./helpers');

// Avant tout chargement du bot : la liste des propriétaires est lue au démarrage.
process.env.OWNER_IDS = 'proprio';
const store = dist('core/store.js');
const { encrypt } = dist('crypto.js');
const serveurs = dist('commands/serveurs.js');

const guild = (id, name, memberCount) => ({ id, name, memberCount, joinedTimestamp: Date.parse('2026-09-01T10:00:00Z') });

function setup() {
    const data = store.loadData();
    data.users.ref1 = { user: encrypt('a.b'), pass: encrypt('x') };
    data.guilds = {
        grand: { announcementChannelId: '1', updateChannelId: '2', referenceUserId: 'ref1', knownProjectIds: [] },
        parti: { announcementChannelId: '3', knownProjectIds: [] }, // le bot a quitté ce serveur
        perdu: { announcementChannelId: '4', referenceUserId: 'disparu', knownProjectIds: [] },
    };
    store.saveData(data);
    return data;
}

test('rapport : serveurs triés par taille, configuration de chacun, compteurs, rien de créé', () => {
    const data = setup();
    const embed = serveurs.serversReport([guild('petit', 'Petit serveur', 8), guild('grand', 'Grand serveur', 120)], data).toJSON();
    assert.strictEqual(embed.title, '🛰️ Serveurs du bot (2)');
    assert.ok(embed.description.indexOf('Grand serveur') < embed.description.indexOf('Petit serveur'));
    assert.match(embed.description, /Grand serveur\*\* · `grand`\n120 membres · arrivé le <t:\d+:D>\nAlertes ✅ · Mises à jour ✅ · Compte de référence ✅/);
    assert.match(embed.description, /Petit serveur\*\* · `petit`\n8 membres · arrivé le <t:\d+:D>\nAlertes ❌ · Mises à jour ❌ · Compte de référence ❌/);
    const field = (name) => embed.fields.find((f) => f.name === name).value;
    assert.strictEqual(field('Membres en tout'), '128');
    assert.strictEqual(field('Configurations sans serveur'), '2 (serveurs quittés)');
    assert.strictEqual(data.guilds.petit, undefined, 'lecture seule : aucune configuration créée');
});

test('rapport : compte de référence déconnecté signalé, nom de serveur sans mise en forme injectée', () => {
    const data = setup();
    const embed = serveurs.serversReport([guild('perdu', '**gras** [lien](https://exemple.test)', 3)], data).toJSON();
    assert.match(embed.description, /Compte de référence ⚠️ déconnecté/);
    assert.doesNotMatch(embed.description, /\*\*gras\*\*/);
    // Crochet échappé : Discord affiche le texte et l'adresse, jamais un lien masqué.
    assert.ok(embed.description.includes('\\[lien]('));
    assert.doesNotMatch(embed.description, /(^|[^\\])\[lien\]\(/);
});

test('rapport : une longue liste est résumée sans dépasser la limite de Discord', () => {
    const data = setup();
    const many = Array.from({ length: 300 }, (_, i) => guild(String(1000 + i), `Serveur ${i}`, 300 - i));
    const embed = serveurs.serversReport(many, data).toJSON();
    assert.ok(embed.description.length <= 4096, String(embed.description.length));
    assert.match(embed.description, /… et \d+ autres serveurs\.$/);
    assert.strictEqual(embed.title, '🛰️ Serveurs du bot (300)');
});

test('/serveurs : refusée à tout autre que le propriétaire, réponse privée pour lui', async () => {
    setup();
    const replies = [];
    const interaction = (id) => ({
        user: { id },
        client: { guilds: { cache: new Map([['grand', { ...guild('grand', 'Grand serveur', 120), joinedTimestamp: Date.now() }]]) } },
        reply: async (r) => replies.push(r),
    });
    await serveurs.default.execute(interaction('quelqu-un'));
    assert.match(replies.at(-1).content, /réservée au propriétaire/);
    assert.strictEqual(replies.at(-1).embeds, undefined);

    await serveurs.default.execute(interaction('proprio'));
    assert.strictEqual(replies.at(-1).embeds[0].data.title, '🛰️ Serveurs du bot (1)');
    assert.ok(replies.at(-1).flags, 'visible par lui seul');
});

test('/serveurs : masquée aux membres ordinaires, utilisable en message privé avec le bot', () => {
    const json = serveurs.default.data.toJSON();
    assert.strictEqual(json.default_member_permissions, '8'); // administrateur
    assert.deepStrictEqual(json.contexts, [0, 1]); // serveur, message privé avec le bot
});
