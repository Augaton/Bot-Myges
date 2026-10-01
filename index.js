// Point d'entrée de production (`npm start` ou `node index.js`).
//
// Petit superviseur : lance le bot (dist/index.js) dans un processus enfant et
// le relance automatiquement s'il s'arrête sur une erreur, avec un délai
// croissant. Le bot reste ainsi en ligne même hébergé sans systemd, pm2 ou
// Docker (panel, screen, tmux…).
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const entry = path.join(__dirname, 'dist', 'index.js');

if (!fs.existsSync(entry)) {
    console.error(
        '❌ dist/ introuvable.\n' +
        '   Compile le bot avant de le lancer :\n' +
        '       npm ci && npm run build\n' +
        "   Puis démarre-le avec `npm start` (ou `node index.js`)."
    );
    process.exit(1);
}

// Doit correspondre à EXIT_CONFIG (src/config.ts) : token absent, clé de
// chiffrement invalide… Relancer n'y changerait rien.
const EXIT_CONFIG = 78;
const MIN_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;
// Un bot resté en ligne au moins ce temps est considéré comme stable : le
// délai de relance repart du minimum.
const STABLE_AFTER_MS = 5 * 60_000;

let child = null;
let stopping = false;
let delay = MIN_DELAY_MS;
let restartTimer = null;

const stamp = () => new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });

function start() {
    restartTimer = null;
    const startedAt = Date.now();
    child = spawn(process.execPath, [...process.execArgv, entry, ...process.argv.slice(2)], {
        stdio: 'inherit',
        env: {
            // Limite le nombre d'arènes malloc de glibc : avec des threads de
            // rendu natifs (canvas), la RAM gonfle nettement sans ce réglage.
            MALLOC_ARENA_MAX: '2',
            ...process.env,
        },
    });

    child.on('exit', (code, signal) => {
        child = null;
        if (stopping) process.exit(code ?? 0);
        // Arrêt volontaire du bot lui-même : on respecte la décision.
        if (code === 0) process.exit(0);
        if (code === EXIT_CONFIG) {
            console.error(`[${stamp()}] [SUPERVISEUR] Erreur de configuration : pas de relance. Corrige le .env puis redémarre.`);
            process.exit(code);
        }
        if (Date.now() - startedAt > STABLE_AFTER_MS) delay = MIN_DELAY_MS;
        console.error(`[${stamp()}] [SUPERVISEUR] Bot arrêté (${signal ?? `code ${code}`}), relance dans ${delay / 1000} s...`);
        restartTimer = setTimeout(start, delay);
        delay = Math.min(delay * 2, MAX_DELAY_MS);
    });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        stopping = true;
        if (restartTimer) clearTimeout(restartTimer);
        if (child) child.kill(signal);
        else process.exit(0);
    });
}

start();
