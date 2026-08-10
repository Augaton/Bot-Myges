import { ActivityType, Client, Events, GatewayIntentBits, REST, Routes } from 'discord.js';
import * as dotenv from 'dotenv';
import { BOT_VERSION, CHECK_INTERVAL } from './config';
import { commands, commandsJSON } from './core/registry';
import { handleLoginModal, LOGIN_MODAL_ID } from './commands/login';
import { autoLoginUsers } from './tasks/autoLogin';
import { checkNewProjects } from './tasks/projects';
import { announceUpdateIfNeeded } from './tasks/announceUpdate';
import { log, logError } from './utils/logger';
import { handleShare, SHARE_ID } from './utils/share';

dotenv.config();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// --- INIT ---
client.once(Events.ClientReady, async () => {
    log('BOOT', `Bot connecté : ${client.user?.tag} (${BOT_VERSION})`);

    // 1. Statut (instantané visuellement)
    client.user?.setPresence({
        status: 'online',
        activities: [{ name: `MyGes Bot ${BOT_VERSION}`, type: ActivityType.Playing }],
    });

    // 2. Logique lourde : reconnexion des utilisateurs MyGes
    console.log('🔄 Lancement de la reconnexion MyGes...');
    await autoLoginUsers();

    // 3. Enregistrement des commandes slash
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN!);
    try {
        await rest.put(Routes.applicationCommands(client.user!.id), { body: commandsJSON });
        console.log('✅ Commandes enregistrées.');
    } catch (e) {
        console.error(e);
    }

    // 4. Annonce de mise à jour si la version a changé
    await announceUpdateIfNeeded(client);

    // 5. Tâches de fond
    setInterval(() => checkNewProjects(client), CHECK_INTERVAL);
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

client.login(process.env.DISCORD_TOKEN);
