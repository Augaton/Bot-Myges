// Point d'entrée de production (`npm start` ou `node index.js`).
//
// Petit superviseur : lance le bot (dist/index.js) dans un processus enfant et
// le relance automatiquement s'il s'arrête sur une erreur, avec un délai
// croissant. Le bot reste ainsi en ligne même hébergé sans systemd, pm2 ou
// Docker (panel, screen, tmux…).
//
// Si PANEL_PORT est renseigné, il lance aussi le panel étudiant, dans son propre
// processus : une panne de l'un n'atteint pas l'autre, et le panel n'a jamais en
// mémoire le token Discord ni la clé de chiffrement. Un seul serveur à gérer, même
// sur un hébergeur qui n'accepte qu'une commande de démarrage (Pelican…).
//
// Il recopie aussi la sortie de chacun dans logs/<nom>-AAAA-MM-JJ.log (14 jours
// conservés) : sur un panel ou dans screen, la console se perd, et avec elle
// l'explication d'un crash.
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');

const ENTRIES = { bot: 'index.js', panel: path.join('panel', 'server.js') };
// Jamais transmis au panel, même si l'hébergeur les injecte dans l'environnement.
const BOT_SECRETS = ['DISCORD_TOKEN', 'ENCRYPTION_KEY'];

function panelConfigured() {
    if (process.env.PANEL_PORT) return true;
    try {
        return Boolean(parseEnv(fs.readFileSync(path.join(__dirname, '.env'), 'utf-8')).PANEL_PORT);
    } catch {
        return false;
    }
}

// `node index.js panel` supervise le panel seul.
const targets = process.argv[2] === 'panel' ? ['panel'] : panelConfigured() ? ['bot', 'panel'] : ['bot'];
const main = targets[0];

const entry = path.join(__dirname, 'dist', ENTRIES[main]);
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

const stamp = () => new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });

// --- JOURNAL SUR DISQUE ---
// Les journaux citent des ID Discord : comme saved_data.json, ils ne sont
// lisibles que par le compte qui fait tourner le bot.
// Écriture synchrone volontaire : une trace de crash écrite juste avant que le
// superviseur ne s'arrête ne doit pas rester dans un tampon.
const LOG_DIR = path.join(__dirname, 'logs');
const LOG_DAYS = 14;
const DAY_FORMAT = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris' }); // AAAA-MM-JJ

/** Date à Paris au format AAAA-MM-JJ, décalée de `offsetDays` jours. */
const day = (offsetDays = 0) => DAY_FORMAT.format(Date.now() + offsetDays * 86_400_000);

/** Journal d'un programme : un fichier par jour, ouvert au premier message de la journée. */
function createLog(name) {
    let logDay = null;
    let logFd = null;
    // Jour où l'écriture a échoué (disque plein, dossier en lecture seule…) : la
    // console suffit jusqu'au lendemain, où l'on réessaie.
    let pausedOn = null;

    function purgeOld() {
        const oldest = `${name}-${day(-LOG_DAYS)}.log`;
        for (const file of fs.readdirSync(LOG_DIR)) {
            if (file.startsWith(`${name}-`) && /-\d{4}-\d{2}-\d{2}\.log$/.test(file) && file < oldest) fs.rmSync(path.join(LOG_DIR, file), { force: true });
        }
    }

    function open(today) {
        if (logFd !== null) fs.closeSync(logFd);
        logFd = null;
        fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
        fs.chmodSync(LOG_DIR, 0o700); // le mode ne s'applique pas à un dossier existant
        purgeOld();
        logFd = fs.openSync(path.join(LOG_DIR, `${name}-${today}.log`), 'a', 0o600);
        fs.fchmodSync(logFd, 0o600); // ni à un fichier existant
        logDay = today;
    }

    return function write(chunk) {
        const today = day();
        if (today === pausedOn) return;
        try {
            if (today !== logDay) open(today);
            fs.writeSync(logFd, chunk);
        } catch (e) {
            pausedOn = today;
            logDay = null; // rouvert proprement le lendemain
            process.stderr.write(`[${stamp()}] [SUPERVISEUR] Écriture du journal impossible (${e.message}) : console seule jusqu'à demain.\n`);
        }
    };
}

let stopping = false;
const running = new Map(); // nom → { child, timer }

/** Arrête tout ; le superviseur se termine quand plus rien ne tourne. */
function stopAll(code, signal = 'SIGTERM') {
    stopping = true;
    for (const [name, state] of running) {
        if (state.timer) {
            clearTimeout(state.timer);
            running.delete(name);
        } else {
            state.child?.kill(signal);
        }
    }
    if (!running.size) process.exit(code);
    stopCode = code;
}
let stopCode = 0;

function supervise(name) {
    const writeLog = createLog(name);
    const say = (message) => {
        const line = `[${stamp()}] [SUPERVISEUR] ${message}\n`;
        process.stderr.write(line);
        writeLog(line);
    };
    let delay = MIN_DELAY_MS;
    const state = { child: null, timer: null };
    running.set(name, state);

    function start() {
        state.timer = null;
        const startedAt = Date.now();
        const env = {
            // Limite le nombre d'arènes malloc de glibc : avec des threads de
            // rendu natifs (canvas), la RAM gonfle nettement sans ce réglage.
            MALLOC_ARENA_MAX: '2',
            ...process.env,
        };
        if (name === 'panel') for (const secret of BOT_SECRETS) delete env[secret];
        const child = spawn(process.execPath, [...process.execArgv, path.join(__dirname, 'dist', ENTRIES[name]), ...process.argv.slice(2)], {
            stdio: ['inherit', 'pipe', 'pipe'],
            env,
        });
        state.child = child;
        child.stdout.on('data', (chunk) => {
            process.stdout.write(chunk);
            writeLog(chunk);
        });
        child.stderr.on('data', (chunk) => {
            process.stderr.write(chunk);
            writeLog(chunk);
        });

        // 'close' et non 'exit' : attend que toute la sortie (la trace d'un crash,
        // notamment) soit lue et journalisée.
        child.on('close', (code, signal) => {
            state.child = null;
            if (stopping) {
                running.delete(name);
                if (!running.size) process.exit(stopCode || (code ?? 0));
                return;
            }
            const isMain = name === main;
            // Arrêt volontaire du bot lui-même : on respecte la décision.
            if (isMain && code === 0) return stopAll(0);
            if (code === EXIT_CONFIG || code === 0) {
                say(code === 0 ? `${name} arrêté.` : `Erreur de configuration de ${name} : pas de relance. Corrige le .env puis redémarre.`);
                running.delete(name);
                if (isMain) stopAll(code);
                return; // le panel mal configuré ne doit pas emporter le bot
            }
            if (Date.now() - startedAt > STABLE_AFTER_MS) delay = MIN_DELAY_MS;
            say(`${name} arrêté (${signal ?? `code ${code}`}), relance dans ${delay / 1000} s...`);
            state.timer = setTimeout(start, delay);
            delay = Math.min(delay * 2, MAX_DELAY_MS);
        });
    }

    start();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => stopAll(0, signal));
}

for (const name of targets) supervise(name);
