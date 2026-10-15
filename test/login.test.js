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

test('MyGes en panne : l\'essai ne compte pas dans la limite', async () => {
    const calls = mockFetch(Array.from({ length: 6 }, () => json(503, {})));
    for (let i = 0; i < 6; i++) assert.match(await submit('d-panne', 'c.trois'), /MyGes ne répond pas/);
    assert.strictEqual(calls.length, 6);
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
