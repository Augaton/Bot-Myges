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
        .setTitle(`🚀 Mise à jour ${BOT_VERSION} - "Ton agenda dans ton téléphone"`)
        .setDescription('Abonne ton calendrier à ton agenda MyGES, retrouve tes projets des années passées, et l\'annuaire sépare ta classe de tes promotions.')
        .setColor(0x5865f2)
        .setThumbnail(client.user?.displayAvatarURL() || null)
        .addFields(
            {
                name: '📅 Abonnement d\'agenda',
                value:
                    '• `/abonnement` te donne un lien à coller dans Google Agenda ou ton iPhone : ton agenda s\'y met à jour tout seul.\n' +
                    '• Garde-le pour toi. « Nouveau lien » le remplace, « Supprimer » le coupe.',
            },
            {
                name: '🗂️ Projets et années passées',
                value:
                    '• Les projets des années passées dans le panel, en consultation.\n' +
                    '• L\'heure limite des rendus, quand MyGES la donne.\n' +
                    '• Les supports du cours depuis la page d\'un projet, et l\'option `annee` sur `/documents`.',
            },
            {
                name: '👥 Annuaire et appareils',
                value:
                    '• **Ma classe** et tes **promotions** séparées dans l\'annuaire.\n' +
                    '• Mon profil : **déconnecter tes autres appareils**, pratique si tu perds ton téléphone.',
            },
            {
                name: '🎒 Rentrée',
                value: '• Tant que MyGES n\'a pas ouvert la nouvelle année, la précédente reste affichée, et un rattrapage déclenche bien une alerte.',
            },
            {
                name: '🌐 Le panel étudiant',
                value:
                    '• `/panel` te donne le lien. Pages plus rapides au premier chargement.\n' +
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
