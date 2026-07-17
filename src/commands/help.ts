import { ChatInputCommandInteraction, EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { Command } from '../core/command';

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('Affiche la liste de toutes les commandes'),

    execute: async (interaction: ChatInputCommandInteraction) => {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const embed = new EmbedBuilder()
            .setTitle('🤖 Guide des Commandes')
            .setDescription('Voici tout ce que je peux faire pour toi :')
            .setColor(0x5865f2)
            .setThumbnail(interaction.client.user?.displayAvatarURL() || null)
            .addFields(
                { name: '🔐 Gestion du Compte', value: '` /login ` : Se connecter (via formulaire sécurisé)\n` /logout ` : Se déconnecter\n` /profil ` : Voir mon profil étudiant' },
                { name: '📅 Organisation', value: '` /agenda ` : Emploi du temps de la semaine\n` /prochain ` : Le prochain cours à venir (Compte à rebours)\n` /projets ` : Liste des projets et deadlines' },
                { name: '🎓 Scolarité', value: '` /notes ` : Bulletin de notes et moyennes\n` /absences ` : Liste des absences' },
                { name: "🏫 Vie de l'École", value: '` /trombi ` : Voir les élèves de ta classe\n` /profs ` : Liste et emails de tes intervenants\n` /campus ` : Codes d\'accès et adresses\n` /news ` : Actualités de l\'école' },
                { name: '⚙️ Système', value: '` /ping ` : Vérifier l\'état du bot et de MyGes\n` /changelog ` : Voir les dernières mises à jour\n` /config ` : Configurer le bot *(administrateurs)*' }
            )
            .setFooter({ text: 'Bot développé avec ❤️ (Amour si vous avez pas saisi)' });

        await interaction.editReply({ embeds: [embed] });
    },
};

export default command;
