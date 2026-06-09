import { ChatInputCommandInteraction, EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { Command } from '../core/command';
import { BOT_VERSION } from '../config';

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('changelog')
        .setDescription('Affiche les dernières nouveautés du bot (v2.0)'),

    execute: async (interaction: ChatInputCommandInteraction) => {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const embed = new EmbedBuilder()
            .setTitle(`🚀 Mise à jour ${BOT_VERSION} - "Navigation & Clarté"`)
            .setDescription("Une mise à jour majeure pour l'organisation et la lisibilité de votre emploi du temps.")
            .setColor(0x9b59b6)
            .setThumbnail(interaction.client.user?.displayAvatarURL() || null)
            .addFields(
                { name: '📅 Agenda V3', value: '• **Navigation Fluide** : Passez de la vue `Jour` à `Semaine` en un clic.\n• **Saut dans le temps** : Utilisez le bouton `🔍 Aller à...` pour voir l\'agenda d\'une date précise.\n• **Design Épuré** : La vue semaine est maintenant compacte et lisible.' },
                { name: '📍 Précision des Lieux', value: '• **Multi-Salles** : Affiche désormais toutes les salles (ex: `B01, B02`) pour les examens ou TP.\n• **Campus Intelligent** : Le bot détecte automatiquement le campus (Nation, Voltaire, Erard...) via l\'API.' },
                { name: '🎨 Icônes Dynamiques', value: '• Ajout de **+50 émojis** pour reconnaître vos matières en un coup d\'œil (☕ Java, ⚙️ Assembleur, ☁️ Cloud, 🛡️ Sécurité...).' },
                { name: '🛠️ Correctifs', value: '• Correction du crash lors des semaines vides.\n• Amélioration de la commande `/prochain`.' }
            )
            .setFooter({ text: "Merci d'utiliser MyGes Bot ! 🎓" })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    },
};

export default command;
