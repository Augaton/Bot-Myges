// Formulaire de connexion : limite d'essais et changement de compte MyGes.
const test = require('node:test');
const assert = require('node:assert');
const { dist, mockFetch, json, redirect } = require('./helpers');

const store = dist('core/store.js');
const { handleLoginModal } = dist('commands/login.js');

/** Soumet le formulaire comme le ferait Discord ; renvoie le texte de la réponse. */
async function submit(discordId, username, password = 'secret') {
    const replies = [];
    await handleLoginModal({
        user: { id: discordId, tag: discordId },
        client: {},
        fields: { getTextInputValue: (id) => (id === 'usernameInput' ? username : password) },
        deferReply: async () => {},
        editReply: async (reply) => replies.push(typeof reply === 'string' ? reply : reply.content),
    });
    return replies.at(-1);
}

const accepted = () => redirect('x:/#access_token=t&token_type=bearer&expires_in=3600');

test('5 essais ratés au plus par identifiant MyGes, même depuis plusieurs comptes Discord', async () => {
    const calls = mockFetch(Array.from({ length: 5 }, () => json(401, {})));
    for (let i = 0; i < 5; i++) {
        assert.match(await submit(`d${i}`, i % 2 ? 'P.Nom' : 'p.nom'), /Échec de la connexion/);
    }
    assert.match(await submit('d5', 'p.nom'), /Trop de tentatives/);
    assert.strictEqual(calls.length, 5); // le 6e essai n'atteint pas MyGes
});

test('reconnexion avec un autre compte MyGes : l\'historique des alertes repart de zéro', async () => {
    mockFetch([accepted()]);
    await submit('u1', 'a.un');
    const data = store.loadData();
    const alerts = store.getUserAlerts(data, 'u1');
    alerts.knownGrades = ['empreinte'];
    alerts.grades = false; // une préférence, elle, est conservée
    store.saveData(data);

    mockFetch([accepted()]);
    await submit('u1', 'A.Un'); // même compte, casse différente
    assert.deepStrictEqual(store.loadData().alerts.u1.knownGrades, ['empreinte']);

    mockFetch([accepted()]);
    await submit('u1', 'b.deux');
    assert.strictEqual(store.loadData().alerts.u1.knownGrades, undefined);
    assert.strictEqual(store.loadData().alerts.u1.grades, false);
});

test('reconnexion avec un autre compte MyGes : le lien d\'abonnement d\'agenda est coupé', async () => {
    const { createFeed, feedSecret } = dist('tasks/agendaFeeds.js');
    mockFetch([accepted()]);
    assert.match(await submit('u8', 'c.trois'), /Connexion réussie/);
    const secret = createFeed('u8');

    mockFetch([accepted()]);
    assert.match(await submit('u8', 'C.Trois'), /Connexion réussie/); // même compte : le lien reste
    assert.strictEqual(feedSecret('u8'), secret);

    mockFetch([accepted()]);
    assert.match(await submit('u8', 'd.quatre'), /Connexion réussie/); // autre compte : il servait l'ancien, il est coupé
    assert.strictEqual(feedSecret('u8'), null);
    assert.strictEqual(store.loadData().feeds?.u8, undefined);
});

test('un « : » dans l\'identifiant ne contourne pas la limite par identifiant', async () => {
    // En Basic, « cible:essai » testerait le mot de passe « essai… » sur « cible »
    // tout en comptant les tentatives sur un identifiant toujours différent.
    const calls = mockFetch([]);
    assert.match(await submit('d-colon', 'cible:essai1'), /Identifiant invalide/);
    assert.match(await submit('d-colon', 'p nom'), /Identifiant invalide/);
    assert.strictEqual(calls.length, 0);
});

test('MyGes en panne : l\'essai ne compte pas dans la limite', async () => {
    const calls = mockFetch(Array.from({ length: 6 }, () => json(503, {})));
    for (let i = 0; i < 6; i++) assert.match(await submit('d-panne', 'c.trois'), /MyGes ne répond pas/);
    assert.strictEqual(calls.length, 6);
});

test('refus non expliqué (403) : le message ne parle pas de mot de passe, mais l\'essai compte', async () => {
    const calls = mockFetch(Array.from({ length: 5 }, () => json(403, {})));
    for (let i = 0; i < 5; i++) assert.match(await submit('d-403', 'f.six'), /erreur 403/);
    assert.match(await submit('d-403', 'f.six'), /Trop de tentatives/);
    assert.strictEqual(calls.length, 5);
});

test('un tiers qui épuise les essais sur un identifiant ne bloque pas son titulaire déjà connecté', async () => {
    mockFetch([accepted()]);
    await submit('titulaire', 'e.cinq');
    mockFetch(Array.from({ length: 5 }, () => json(401, {})));
    for (let i = 0; i < 5; i++) await submit(`intrus${i}`, 'e.cinq');
    assert.match(await submit('intrus5', 'e.cinq'), /Trop de tentatives/);

    mockFetch([accepted()]);
    assert.match(await submit('titulaire', 'E.Cinq'), /Connexion réussie/);
});

// À laisser en dernier : le compteur est global à ce fichier de test.
test('pulvérisation : plafond global d\'échecs, tous comptes et identifiants confondus', async () => {
    const calls = mockFetch(Array.from({ length: 30 }, () => json(401, {})));
    const replies = [];
    for (let i = 0; i < 40; i++) replies.push(await submit(`spray${i}`, `cible${i}`));
    assert.ok(replies.some((r) => /Trop d'échecs/.test(r)));
    assert.ok(calls.length <= 30);
});

