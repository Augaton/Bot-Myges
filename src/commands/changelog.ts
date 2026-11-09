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
        .setTitle(`🚀 Mise à jour ${BOT_VERSION} - "Reste connecté"`)
        .setDescription('Le panel étudiant garde ta session si tu le demandes, et le bot tient mieux le coup quand MyGES a des soucis.')
        .setColor(0x5865f2)
        .setThumbnail(client.user?.displayAvatarURL() || null)
        .addFields(
            {
                name: '🌐 Le panel étudiant',
                value:
                    '• **Rester connecté** : une case à cocher, à éviter sur un ordinateur partagé. Ton mot de passe n\'est jamais enregistré.\n' +
                    '• Le **prochain examen** à l\'accueil, et l\'agenda s\'ouvre sur aujourd\'hui sur ton téléphone.\n' +
                    '• Pages plus légères et plus rapides à charger.\n' +
                    '• `/panel` te donne le lien. Service non officiel, sans lien avec MyGES ni le Réseau GES.' +
                    (panelLink ? `\n• Accès : ${panelLink}` : ''),
            },
            {
                name: '🔔 Alertes plus fiables',
                value:
                    '• Mot de passe changé sur MyGES : le bot te prévient une fois en MP et cesse d\'essayer, pour ne pas faire verrouiller ton compte.\n' +
                    '• MyGES en panne : tes rappels de rendu partent quand même.\n' +
                    '• Les projets encore en brouillon ne sont plus annoncés.',
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
