import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { Command, CommandInteraction } from '../core/command';
import { closeSession, hasAccount, loadData, saveData } from '../core/store';
import { forgetUser } from '../core/mygesData';
import { log } from '../utils/logger';
import { removeFeed } from '../tasks/agendaFeeds';
import { dropTicket } from '../utils/panelTicket';

// Bouton « Oui, me déconnecter », routé globalement (voir index.ts).
export const LOGOUT_CONFIRM_ID = 'logout:oui';

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('logout')
        .setDescription('Déconnexion et suppression de tes données'),

    execute: async (interaction: CommandInteraction) => {
        // 1. On vérifie d'abord si l'utilisateur a des identifiants enregistrés.
        // (Pas seulement une session ouverte : celle-ci n'est rétablie qu'au
        // premier usage après un redémarrage, les identifiants existent avant.)
        if (!hasAccount(interaction.user.id)) {
            closeSession(interaction.user.id);
            return interaction.reply({
                content: "❌ **Erreur :** Tu n'es pas connecté. Aucune donnée à supprimer.",
                flags: MessageFlags.Ephemeral,
            });
        }

        // Depuis le tableau de bord, un clic de travers sur un message public ne
        // doit rien effacer : on demande d'abord confirmation.
        if (interaction.isButton() && interaction.customId !== LOGOUT_CONFIRM_ID) {
            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setTitle('🚪 Te déconnecter ?')
                    .setDescription('Je supprime tes identifiants MyGES, tes réglages d\'alertes et ton lien d\'abonnement calendrier.\nPour annuler, ignore simplement ce message.')
                    .setColor(0xe74c3c)],
                components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId(LOGOUT_CONFIRM_ID).setLabel('Oui, me déconnecter').setStyle(ButtonStyle.Danger),
                )],
                flags: MessageFlags.Ephemeral,
            });
        }

        // 2. On supprime de la mémoire vive (session active, données en cache)
        closeSession(interaction.user.id);
        forgetUser(interaction.user.id);

        // 3. On supprime du disque (identifiants et alertes)
        removeFeed(interaction.user.id); // le lien d'abonnement cesse de fonctionner
        dropTicket(interaction.user.id); // le lien de connexion au panel aussi
        const data = loadData();
        delete data.users[interaction.user.id];
        delete data.alerts[interaction.user.id];

        // 4. On retire ce compte de toute config où il servait de référence :
        // se déconnecter doit couper net l'usage de ses données.
        let removedRefs = 0;
        for (const cfg of Object.values(data.guilds)) {
            if (cfg.referenceUserId === interaction.user.id) {
                delete cfg.referenceUserId;
                removedRefs++;
            }
        }
        saveData(data); // Sauvegarde immédiate
        log('AUTH', `${interaction.user.id} déconnecté${removedRefs > 0 ? ` : retiré comme compte de référence sur ${removedRefs} serveur(s)` : ''}.`);

        // 5. Message de confirmation rassurant
        const embed = new EmbedBuilder()
            .setTitle('👋 Déconnexion réussie')
            .setDescription('Tes identifiants ont été **supprimés** de ma base de données.\nJe ne pourrai plus accéder à ton compte MyGes.\nSi le panel est ouvert, sa session dure jusqu\'à ce que tu t\'y déconnectes ou fermes ton navigateur.')
            .setColor(0xe74c3c)
            .setThumbnail(interaction.user.displayAvatarURL())
            .setFooter({ text: 'À bientôt ! Utilise /login pour revenir.' })
            .setTimestamp();

        // Après confirmation, la réponse remplace la question (et son bouton).
        if (interaction.isButton()) await interaction.update({ embeds: [embed], components: [] });
        else await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
};

export default command;
