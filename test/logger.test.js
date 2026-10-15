const test = require('node:test');
const assert = require('node:assert');
const { dist } = require('./helpers');

const { logError } = dist('utils/logger.js');

test('une erreur d\'API Discord est journalisée sans l\'URL (jeton d\'interaction) ni le corps envoyé', (t) => {
    const printed = [];
    t.mock.method(console, 'error', (...args) => printed.push(args));
    const err = Object.assign(new Error('Unknown interaction'), {
        name: 'DiscordAPIError[10062]',
        code: 10062,
        status: 404,
        method: 'PATCH',
        url: 'https://discord.com/api/v10/webhooks/123/JETON-SECRET/messages/@original',
        requestBody: { json: { content: 'note : 17/20' } },
    });
    logError('CMD', 'Erreur :', err, 'contexte');
    const out = printed[0].map(String).join(' ');
    assert.doesNotMatch(out, /JETON-SECRET|17\/20/);
    assert.match(out, /DiscordAPIError\[10062\] \[HTTP 404, code 10062\] PATCH : Unknown interaction contexte/);
});
