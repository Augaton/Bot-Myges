import {
    ActionRowBuilder, ChatInputCommandInteraction, ModalBuilder, ModalSubmitInteraction,
    MessageFlags, SlashCommandBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { Command } from '../core/command';
import { GesAPI } from '../myges/ges-api';
import { encrypt } from '../crypto';
import { loadData, makeSession, saveData, sessions } from '../core/store';
import { checkNewProjects } from '../tasks/projects';

export const LOGIN_MODAL_ID = 'loginModal';

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
            .setRequired(true);

        const passInput = new TextInputBuilder()
            .setCustomId('passwordInput')
            .setLabel('Mot de passe')
            .setPlaceholder('Ton mot de passe')
            .setStyle(TextInputStyle.Short) // Masqué à l'envoi, mais visible à la frappe (limitation Discord)
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

    const username = interaction.fields.getTextInputValue('usernameInput');
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

        // Sauvegarde Session (auto-rafraîchissante)
        sessions.set(interaction.user.id, makeSession(interaction.user.id, token));

        await interaction.editReply({
            content: `✅ **Connexion réussie !**\nBonjour **${username}**, je suis connecté à ton compte MyGes.\nTu peux maintenant utiliser \`/agenda\`, \`/notes\`, etc.`,
        });

        console.log(`✅ Utilisateur ${username} (${interaction.user.id}) connecté.`);

        // Premier check pour charger les données (projets, etc.)
        checkNewProjects(interaction.client);
    } catch (error) {
        console.error(error);
        await interaction.editReply({
            content: '❌ **Échec de la connexion.**\nVérifie tes identifiants.\n*(Si le problème persiste, MyGes est peut-être en maintenance)*',
        });
        console.log(`❌ Échec de connexion pour l'utilisateur ${username} (${interaction.user.id}).`);
    }
}

export default command;
