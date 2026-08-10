import { ChatInputCommandInteraction, EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { Command } from '../core/command';
import { loadData, saveData, sessions } from '../core/store';
import { log } from '../utils/logger';

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('logout')
        .setDescription('Déconnexion et suppression de tes données'),

    execute: async (interaction: ChatInputCommandInteraction) => {
        // 1. On vérifie d'abord si l'utilisateur est connecté
        if (!sessions.has(interaction.user.id)) {
            return interaction.reply({
                content: "❌ **Erreur :** Tu n'es pas connecté. Aucune donnée à supprimer.",
                flags: MessageFlags.Ephemeral,
            });
        }

        // 2. On supprime de la mémoire vive (Session active)
        sessions.delete(interaction.user.id);

        // 3. On supprime du disque (Fichier JSON)
        const data = loadData();
        delete data.users[interaction.user.id];

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
        if (removedRefs > 0) {
            log('AUTH', `${interaction.user.id} déconnecté : retiré comme compte de référence sur ${removedRefs} serveur(s).`);
        }

        // 4. Message de confirmation rassurant
        const embed = new EmbedBuilder()
            .setTitle('👋 Déconnexion réussie')
            .setDescription('Tes identifiants ont été **supprimés** de ma base de données.\nJe ne pourrai plus accéder à ton compte MyGes.')
            .setColor(0xe74c3c)
            .setThumbnail(interaction.user.displayAvatarURL())
            .setFooter({ text: 'À bientôt ! Utilise /login pour revenir.' })
            .setTimestamp();

        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
};

export default command;
