// En premier : charge le .env et fixe le fuseau horaire avant tout le reste.
import { BOT_VERSION, CHECK_INTERVAL, DB_FILE, EXIT_CONFIG } from './config';
import {
    ActivityType, Client, Events, GatewayIntentBits, MessageFlags, Options, Status,
} from 'discord.js';
import { commands, commandsJSON } from './core/registry';
import { loadData, sessionCount } from './core/store';
import { handleLoginModal, LOGIN_MODAL_ID } from './commands/login';
import { runProjectCheck } from './tasks/projects';
import { PERSONAL_CHECK_INTERVAL, runPersonalCheck } from './tasks/personalAlerts';
import { announceUpdateIfNeeded } from './tasks/announceUpdate';
import { log, logError } from './utils/logger';
import { handleShare, SHARE_ID } from './utils/share';
import { shutdownRenderPool } from './utils/renderPool';

// --- CONFIGURATION REQUISE ---
// Sur un serveur, mieux vaut refuser de démarrer avec un message clair que de
// boucler sur des erreurs de connexion Discord illisibles.
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
    console.error('❌ ERREUR CRITIQUE : DISCORD_TOKEN absent (.env ou variable d\'environnement).');
    process.exit(EXIT_CONFIG);
}

// Données chargées (et chiffrement migré au besoin) dès le démarrage : un
// fichier corrompu doit empêcher le lancement, pas faire échouer chaque commande.
try {
    loadData();
} catch (e) {
    console.error(`❌ ERREUR CRITIQUE : lecture de ${DB_FILE} impossible :`, e);
    process.exit(EXIT_CONFIG);
}

const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    // Le bot ne relit jamais d'anciens messages : inutile d'en garder 200 par
    // salon en mémoire pendant des semaines.
    makeCache: Options.cacheWithLimits({
        ...Options.DefaultMakeCacheSettings,
        MessageManager: 25,
    }),
    sweepers: {
        ...Options.DefaultSweeperSettings,
        messages: { interval: 3600, lifetime: 1800 },
    },
});

// --- FILETS DE SÉCURITÉ PROCESSUS ---
let shuttingDown = false;
const timers: NodeJS.Timeout[] = [];

/** Arrêt propre : ferme la passerelle Discord et les threads de rendu. */
function shutdown(reason: string, code: number) {
    if (shuttingDown) return;
    shuttingDown = true;
    log('SHUTDOWN', `${reason}, arrêt en cours...`);
    for (const t of timers) clearInterval(t);
    // Garde-fou : quoi qu'il arrive, le processus se termine.
    setTimeout(() => process.exit(code), 10_000).unref();
    Promise.allSettled([client.destroy(), shutdownRenderPool()])
        .finally(() => process.exit(code));
}

// Une promesse rejetée non gérée vient presque toujours d'un appel Discord ou
// MyGes isolé (interaction expirée…) : on journalise et on continue.
process.on('unhandledRejection', (reason) => {
    logError('PROCESS', 'Promesse rejetée non gérée :', reason);
});
// Une exception non interceptée, en revanche, laisse le processus dans un état
// incertain (Node le déconseille formellement) : un bot « vivant » mais à moitié
// cassé est pire qu'un redémarrage. On s'arrête proprement, le superviseur
// (index.js ou systemd) relance le bot dans la foulée.
process.on('uncaughtException', (err) => {
    logError('PROCESS', 'Exception non interceptée, redémarrage :', err);
    shutdown('Exception non interceptée', 1);
});

// discord.js émet 'error' sur le client ; sans écouteur, Node relance l'erreur.
client.on(Events.Error, (e) => logError('DISCORD', 'Erreur client :', e));
client.on(Events.Warn, (m) => log('DISCORD', `Avertissement : ${m}`));
// Coupures de la passerelle : journalisées pour diagnostiquer un bot qui
// « disparaît » au bout de plusieurs heures.
client.on(Events.ShardDisconnect, (e, id) => log('DISCORD', `Passerelle ${id} déconnectée (code ${e.code}).`));
client.on(Events.ShardReconnecting, (id) => log('DISCORD', `Passerelle ${id} : reconnexion...`));
client.on(Events.ShardResume, (id, replayed) => log('DISCORD', `Passerelle ${id} rétablie (${replayed} évènement(s) rejoué(s)).`));
client.on(Events.ShardError, (e, id) => logError('DISCORD', `Erreur de passerelle ${id} :`, e));
client.on(Events.Invalidated, () => {
    logError('DISCORD', 'Session Discord invalidée.');
    shutdown('Session Discord invalidée', 1);
});

// --- SURVEILLANCE ---
// discord.js se reconnecte seul après une coupure. S'il n'y parvient pas en
// 15 min, on redémarre plutôt que de rester en ligne en apparence mais sourd.
const GATEWAY_WATCHDOG_MS = 15 * 60 * 1000;
let gatewayDownSince: number | null = null;

function watchGateway() {
    if (client.ws.status === Status.Ready) {
        gatewayDownSince = null;
        return;
    }
    gatewayDownSince ??= Date.now();
    if (Date.now() - gatewayDownSince > GATEWAY_WATCHDOG_MS) {
        logError('WATCHDOG', `Passerelle Discord indisponible depuis plus de ${GATEWAY_WATCHDOG_MS / 60_000} min.`);
        shutdown('Passerelle Discord bloquée', 1);
    }
}

/** Point de santé horaire : permet de repérer une dérive mémoire dans les logs. */
function logHealth() {
    const mem = process.memoryUsage();
    const mo = (b: number) => `${Math.round(b / 1048576)} Mo`;
    log(
        'SANTÉ',
        `RAM ${mo(mem.rss)} (tas JS ${mo(mem.heapUsed)}) · ${sessionCount()} session(s) MyGes · ` +
        `${client.guilds.cache.size} serveur(s) · ping ${client.ws.ping} ms · en ligne depuis ${Math.round(process.uptime() / 3600)} h`
    );
}

// --- INIT ---
client.once(Events.ClientReady, async (ready) => {
    log('BOOT', `Bot connecté : ${ready.user.tag} (${BOT_VERSION}) · Node ${process.version} · fuseau ${process.env.TZ}`);

    // 1. Statut (instantané visuellement)
    ready.user.setPresence({
        status: 'online',
        activities: [{ name: `MyGes Bot ${BOT_VERSION}`, type: ActivityType.Playing }],
    });

    // 2. Enregistrement des commandes slash
    try {
        await ready.application.commands.set(commandsJSON);
        log('BOOT', `${commandsJSON.length} commandes enregistrées.`);
    } catch (e) {
        logError('BOOT', 'Enregistrement des commandes impossible :', e);
    }

    // 3. Annonce de mise à jour si la version a changé
    await announceUpdateIfNeeded(client);

    // 4. Tâches de fond. Les sessions MyGes ne sont plus rouvertes en bloc au
    // démarrage : chacune est rétablie à la demande, au premier usage.
    timers.push(
        setInterval(() => runProjectCheck(client), CHECK_INTERVAL),
        // Alertes en MP (notes, rappels) : premier passage 2 min après le
        // démarrage, le temps que la passerelle se stabilise.
        setTimeout(() => runPersonalCheck(client), 2 * 60_000),
        setInterval(() => runPersonalCheck(client), PERSONAL_CHECK_INTERVAL),
        setInterval(watchGateway, 60_000),
        setInterval(logHealth, 60 * 60 * 1000),
    );
    logHealth();
});

// --- ROUTAGE DES INTERACTIONS ---
client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand()) {
        const command = commands.get(interaction.commandName);
        if (!command) return;
        const who = `${interaction.user.tag} (${interaction.user.id})`;
        log('CMD', `/${interaction.commandName} par ${who}`);
        try {
            await command.execute(interaction);
        } catch (e) {
            logError('CMD', `Erreur /${interaction.commandName} (${who}) :`, e);
            // Sans cela, Discord laisse la commande sur « réfléchit… » indéfiniment.
            const oops = '❌ Une erreur est survenue. Réessaie dans un instant.';
            try {
                if (interaction.deferred || interaction.replied) await interaction.editReply({ content: oops, embeds: [], components: [], attachments: [] });
                else await interaction.reply({ content: oops, flags: MessageFlags.Ephemeral });
            } catch {
                /* interaction expirée : rien de plus à faire */
            }
        }
        return;
    }

    // Bouton « partager » : routé ici pour fonctionner sur toutes les commandes,
    // y compris celles qui n'ouvrent pas de collecteur.
    if (interaction.isButton() && interaction.customId === SHARE_ID) {
        await handleShare(interaction);
        return;
    }

    if (interaction.isModalSubmit()) {
        log('MODAL', `${interaction.customId} par ${interaction.user.tag} (${interaction.user.id})`);
        if (interaction.customId === LOGIN_MODAL_ID) {
            try {
                await handleLoginModal(interaction);
            } catch (e) {
                logError('MODAL', 'Traitement de la connexion impossible :', e);
            }
        }
    }
});

// --- ARRÊT PROPRE ---
// systemd/Docker envoient SIGTERM : on ferme la passerelle Discord au lieu de
// laisser la connexion mourir, ce qui évite un statut « en ligne » fantôme.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => shutdown(`${signal} reçu`, 0));
}

client.login(TOKEN).catch((e) => {
    logError('BOOT', 'Connexion à Discord impossible :', e);
    // Token refusé : relancer en boucle n'y changerait rien.
    process.exit(e?.code === 'TokenInvalid' ? EXIT_CONFIG : 1);
});
