import { ActivityType, Client, Events, GatewayIntentBits, MessageFlags, REST, Routes } from 'discord.js';
import { BOT_VERSION, CHECK_INTERVAL } from './config'; // charge aussi le .env
import { commands, commandsJSON } from './core/registry';
import { handleLoginModal, LOGIN_MODAL_ID } from './commands/login';
import { autoLoginUsers } from './tasks/autoLogin';
import { runProjectCheck } from './tasks/projects';
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
    process.exit(1);
}

// --- FILETS DE SÉCURITÉ PROCESSUS ---
// Node termine le processus sur une promesse rejetée non gérée : un simple
// editReply en échec suffirait à tuer le bot. On journalise et on continue.
process.on('unhandledRejection', (reason) => {
    logError('PROCESS', 'Promesse rejetée non gérée :', reason);
});
process.on('uncaughtException', (err) => {
    logError('PROCESS', 'Exception non interceptée :', err);
});

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// discord.js émet 'error' sur le client ; sans écouteur, Node relance l'erreur.
client.on(Events.Error, (e) => logError('DISCORD', 'Erreur client :', e));
client.on(Events.Warn, (m) => log('DISCORD', `Avertissement : ${m}`));

// Tâche de fond des alertes projets (le garde-fou anti-chevauchement et la
// capture d'erreurs vivent dans tasks/projects, partagés avec /login).
let projectTimer: NodeJS.Timeout | null = null;

// --- INIT ---
client.once(Events.ClientReady, async () => {
    log('BOOT', `Bot connecté : ${client.user?.tag} (${BOT_VERSION}) · Node ${process.version}`);

    // 1. Statut (instantané visuellement)
    client.user?.setPresence({
        status: 'online',
        activities: [{ name: `MyGes Bot ${BOT_VERSION}`, type: ActivityType.Playing }],
    });

    // 2. Enregistrement des commandes slash — EN PREMIER.
    // La reconnexion MyGes est séquentielle (2 s par compte) : la faire avant
    // laisserait le bot « en ligne » mais sans aucune commande utilisable
    // pendant plusieurs minutes dès qu'il y a quelques dizaines d'utilisateurs.
    const rest = new REST({ version: '10' }).setToken(TOKEN!);
    try {
        await rest.put(Routes.applicationCommands(client.user!.id), { body: commandsJSON });
        log('BOOT', `${commandsJSON.length} commandes enregistrées.`);
    } catch (e) {
        logError('BOOT', 'Enregistrement des commandes impossible :', e);
    }

    // 3. Annonce de mise à jour si la version a changé
    await announceUpdateIfNeeded(client);

    // 4. Tâches de fond (démarrées avant la reconnexion, qui peut être longue)
    projectTimer = setInterval(() => runProjectCheck(client), CHECK_INTERVAL);

    // 5. Reconnexion des comptes MyGes, en arrière-plan.
    // Les commandes répondent déjà « connecte-toi d'abord » tant qu'une session
    // n'est pas rétablie : inutile de bloquer le démarrage pour ça.
    log('BOOT', 'Reconnexion MyGes lancée en arrière-plan...');
    void autoLoginUsers().catch((e) => logError('BOOT', 'Reconnexion MyGes en échec :', e));
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
                if (interaction.deferred || interaction.replied) await interaction.editReply(oops);
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
            await handleLoginModal(interaction);
        }
    }
});

// --- ARRÊT PROPRE ---
// systemd/Docker envoient SIGTERM : on ferme la passerelle Discord au lieu de
// laisser la connexion mourir, ce qui évite un statut « en ligne » fantôme.
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        if (shuttingDown) return;
        shuttingDown = true;
        log('SHUTDOWN', `${signal} reçu, arrêt en cours...`);
        if (projectTimer) clearInterval(projectTimer);
        Promise.allSettled([client.destroy(), shutdownRenderPool()])
            .catch((e) => logError('SHUTDOWN', 'Fermeture imparfaite :', e))
            .finally(() => process.exit(0));
    });
}

client.login(TOKEN);
