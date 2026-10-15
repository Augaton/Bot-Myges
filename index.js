// Point d'entrée de production (`npm start` ou `node index.js`).
//
// Petit superviseur : lance le bot (dist/index.js) dans un processus enfant et
// le relance automatiquement s'il s'arrête sur une erreur, avec un délai
// croissant. Le bot reste ainsi en ligne même hébergé sans systemd, pm2 ou
// Docker (panel, screen, tmux…).
//
// Il recopie aussi la sortie du bot dans logs/bot-AAAA-MM-JJ.log (14 jours
// conservés) : sur un panel ou dans screen, la console se perd, et avec elle
// l'explication d'un crash.
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

// --- JOURNAL SUR DISQUE ---
// Les journaux citent des ID Discord et des identifiants MyGes : comme
// saved_data.json, ils ne sont lisibles que par le compte qui fait tourner le bot.
// Écriture synchrone volontaire : une trace de crash écrite juste avant que le
// superviseur ne s'arrête ne doit pas rester dans un tampon.
const LOG_DIR = path.join(__dirname, 'logs');
const LOG_DAYS = 14;
const DAY_FORMAT = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris' }); // AAAA-MM-JJ
let logDay = null;
let logFd = null;
// Jour où l'écriture a échoué (disque plein, dossier en lecture seule…) : la
// console suffit jusqu'au lendemain, où l'on réessaie.
let logPausedOn = null;

/** Date à Paris au format AAAA-MM-JJ, décalée de `offsetDays` jours. */
const day = (offsetDays = 0) => DAY_FORMAT.format(Date.now() + offsetDays * 86_400_000);

function purgeOldLogs() {
    const oldest = `bot-${day(-LOG_DAYS)}.log`;
    for (const name of fs.readdirSync(LOG_DIR)) {
        if (/^bot-\d{4}-\d{2}-\d{2}\.log$/.test(name) && name < oldest) fs.rmSync(path.join(LOG_DIR, name), { force: true });
    }
}

/** Ouvre le fichier du jour (et fait le ménage) au premier message de la journée. */
function openLog(today) {
    if (logFd !== null) fs.closeSync(logFd);
    logFd = null;
    fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(LOG_DIR, 0o700); // le mode ne s'applique pas à un dossier existant
    purgeOldLogs();
    logFd = fs.openSync(path.join(LOG_DIR, `bot-${today}.log`), 'a', 0o600);
    fs.fchmodSync(logFd, 0o600); // ni à un fichier existant
    logDay = today;
}

function writeLog(chunk) {
    const today = day();
    if (today === logPausedOn) return;
    try {
        if (today !== logDay) openLog(today);
        fs.writeSync(logFd, chunk);
    } catch (e) {
        logPausedOn = today;
        logDay = null; // rouvert proprement le lendemain
        process.stderr.write(`[${stamp()}] [SUPERVISEUR] Écriture du journal impossible (${e.message}) : console seule jusqu'à demain.\n`);
    }
}

/** Message du superviseur, en console et dans le journal. */
function say(message) {
    const line = `[${stamp()}] [SUPERVISEUR] ${message}\n`;
    process.stderr.write(line);
    writeLog(line);
}

function start() {
    restartTimer = null;
    const startedAt = Date.now();
    child = spawn(process.execPath, [...process.execArgv, entry, ...process.argv.slice(2)], {
        stdio: ['inherit', 'pipe', 'pipe'],
        env: {
            // Limite le nombre d'arènes malloc de glibc : avec des threads de
            // rendu natifs (canvas), la RAM gonfle nettement sans ce réglage.
            MALLOC_ARENA_MAX: '2',
            ...process.env,
        },
    });
    child.stdout.on('data', (chunk) => {
        process.stdout.write(chunk);
        writeLog(chunk);
    });
    child.stderr.on('data', (chunk) => {
        process.stderr.write(chunk);
        writeLog(chunk);
    });

    // 'close' et non 'exit' : attend que toute la sortie du bot (la trace d'un
    // crash, notamment) soit lue et journalisée.
    child.on('close', (code, signal) => {
        child = null;
        if (stopping) process.exit(code ?? 0);
        // Arrêt volontaire du bot lui-même : on respecte la décision.
        if (code === 0) process.exit(0);
        if (code === EXIT_CONFIG) {
            say('Erreur de configuration : pas de relance. Corrige le .env puis redémarre.');
            process.exit(code);
        }
        if (Date.now() - startedAt > STABLE_AFTER_MS) delay = MIN_DELAY_MS;
        say(`Bot arrêté (${signal ?? `code ${code}`}), relance dans ${delay / 1000} s...`);
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
