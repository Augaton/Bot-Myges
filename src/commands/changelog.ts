import { ChatInputCommandInteraction, Client, EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { Command } from '../core/command';
import { BOT_VERSION, panelPublicUrl } from '../config';
import { shareRow } from '../utils/share';

/**
 * Construit l'embed du changelog de la version courante.
 * Partagé entre la commande `/changelog` et l'annonce automatique de MAJ.
 */
export function buildChangelogEmbed(client: Client): EmbedBuilder {
    // Annonce publique : le lien du panel n'y figure que s'il a été renseigné.
    const panelLink = panelPublicUrl();
    return new EmbedBuilder()
        .setTitle(`🚀 Mise à jour ${BOT_VERSION} - "Tes années passées"`)
        .setDescription('Retrouve tes notes, absences et supports de cours des années précédentes, et les étudiants de toutes tes promotions.')
        .setColor(0x5865f2)
        .setThumbnail(client.user?.displayAvatarURL() || null)
        .addFields(
            {
                name: '🗂️ Tes années passées',
                value:
                    '• Dans le panel : un choix **Année** en haut de Notes, Absences et Documents. Pratique pour réviser avec les supports de l\'an dernier.\n' +
                    '• Sur Discord : `/notes` et `/absences` ont une option `annee`.',
            },
            {
                name: '👥 Annuaire',
                value:
                    '• Les étudiants de **toutes tes promotions**, avec la promotion sous chaque nom.\n' +
                    '• Toujours uniquement les personnes avec qui tu as été en classe.',
            },
            {
                name: '🌐 Le panel étudiant',
                value:
                    '• `/panel` te donne le lien. Pages plus rapides à charger.\n' +
                    '• Service non officiel, sans lien avec MyGES ni le Réseau GES.' +
                    (panelLink ? `\n• Accès : ${panelLink}` : ''),
            },
            {
                name: '✅ Aucune action requise',
                value: '• Rien à reconfigurer sur Discord.',
            }
        )
        .setFooter({ text: "Merci d'utiliser MyGes Bot ! 🎓" })
        .setTimestamp();
}

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('changelog')
        .setDescription('Affiche les dernières nouveautés du bot'),

    execute: async (interaction: ChatInputCommandInteraction) => {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await interaction.editReply({ embeds: [buildChangelogEmbed(interaction.client)], components: [shareRow()] });
    },
};

export default command;
