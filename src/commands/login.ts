import {
    ActionRowBuilder, ChatInputCommandInteraction, ModalBuilder, ModalSubmitInteraction,
    MessageFlags, SlashCommandBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { Command } from '../core/command';
import { GesAPI } from '../myges/ges-api';
import { BadCredentialsError, MyGesError } from '../myges/errors';
import { encrypt } from '../crypto';
import { loadData, openSession, saveData } from '../core/store';
import { forgetUser } from '../core/mygesData';
import { runProjectCheck } from '../tasks/projects';
import { log, logError } from '../utils/logger';

export const LOGIN_MODAL_ID = 'loginModal';

// --- ANTI-BRUTEFORCE ---
// Chaque soumission teste un mot de passe auprès de MyGes : sans limite, le bot
// servirait de relais pour deviner un mot de passe, et des échecs répétés
// peuvent faire verrouiller le compte MyGes visé.
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map<string, number[]>();

/** Enregistre une tentative ; renvoie le délai d'attente restant (ms) si la limite est atteinte. */
function throttle(userId: string): number {
    const now = Date.now();
    const recent = (attempts.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= MAX_ATTEMPTS) {
        attempts.set(userId, recent);
        return WINDOW_MS - (now - recent[0]);
    }
    recent.push(now);
    attempts.set(userId, recent);
    // Ménage : la map ne garde que les utilisateurs ayant tenté récemment.
    for (const [id, list] of attempts) {
        if (list.every((t) => now - t >= WINDOW_MS)) attempts.delete(id);
    }
    return 0;
}

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('login')
        .setDescription('Connexion à MyGes pour accéder à tes données personnalisées'),

    execute: async (interaction: ChatInputCommandInteraction) => {
        const modal = new ModalBuilder().setCustomId(LOGIN_MODAL_ID).setTitle('Connexion MyGes 🔐');

        const userInput = new TextInputBuilder()
            .setCustomId('usernameInput')
            .setLabel('Identifiant (p.nom)')
            .setPlaceholder('p.nom')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(100)
            .setRequired(true);

        const passInput = new TextInputBuilder()
            .setCustomId('passwordInput')
            .setLabel('Mot de passe')
            .setPlaceholder('Ton mot de passe')
            .setStyle(TextInputStyle.Short) // Masqué à l'envoi, mais visible à la frappe (limitation Discord)
            .setMaxLength(200)
            .setRequired(true);

        const row1 = new ActionRowBuilder<TextInputBuilder>().addComponents(userInput);
        const row2 = new ActionRowBuilder<TextInputBuilder>().addComponents(passInput);
        modal.addComponents(row1, row2);

        await interaction.showModal(modal);
    },
};

// Traitement de la soumission du formulaire de connexion.
export async function handleLoginModal(interaction: ModalSubmitInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const wait = throttle(interaction.user.id);
    if (wait > 0) {
        log('AUTH', `Connexion refusée (trop de tentatives) : ${interaction.user.id}`);
        await interaction.editReply({
            content: `⏳ **Trop de tentatives de connexion.** Réessaie dans ${Math.ceil(wait / 60_000)} min.`,
        });
        return;
    }

    const username = interaction.fields.getTextInputValue('usernameInput').trim();
    const password = interaction.fields.getTextInputValue('passwordInput');

    try {
        const token = await GesAPI.login(username, password);

        // Sauvegarde Disque Chiffrée (avant la session pour que __refresh
        // puisse relire les identifiants en cas de 401)
        const data = loadData();
        data.users[interaction.user.id] = {
            user: encrypt(username),
            pass: encrypt(password),
        };
        saveData(data);

        // Sauvegarde Session (auto-rafraîchissante). Le cache peut contenir les
        // données d'un autre compte MyGes utilisé auparavant : on l'oublie.
        forgetUser(interaction.user.id);
        openSession(interaction.user.id, token);
        attempts.delete(interaction.user.id);

        await interaction.editReply({
            content: `✅ **Connexion réussie !**\nBonjour **${username}**, je suis connecté à ton compte MyGes.\nTu peux maintenant utiliser \`/agenda\`, \`/notes\`, etc.\n\n🔔 Je t'enverrai aussi en MP tes **nouvelles notes** et un **rappel avant chaque rendu** de projet (réglable avec \`/alertes\`).`,
            allowedMentions: { parse: [] },
        });

        log('AUTH', `Connexion réussie : ${username} (${interaction.user.id})`);

        // Premier check pour charger les données (projets, etc.). Volontairement
        // non attendu : la réponse à l'utilisateur ne doit pas dépendre de l'API.
        void runProjectCheck(interaction.client);
    } catch (error) {
        // Un mot de passe refusé n'est pas une panne : le message doit le dire,
        // sinon l'utilisateur réessaie en boucle des identifiants corrects.
        const unavailable = !(error instanceof BadCredentialsError);
        logError('AUTH', `Échec de connexion : ${username} (${interaction.user.id})`, unavailable ? error : '(identifiants refusés)');
        await interaction.editReply({
            content: unavailable
                ? `⚠️ **MyGes ne répond pas correctement${error instanceof MyGesError ? ` (erreur ${error.status})` : ''}.**\nCe n'est pas un problème d'identifiants : réessaie dans quelques minutes.`
                : '❌ **Échec de la connexion.**\nIdentifiant ou mot de passe incorrect.',
        });
    }
}

export default command;
