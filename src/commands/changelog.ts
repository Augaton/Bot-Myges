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
        .setTitle(`🚀 Mise à jour ${BOT_VERSION} - "Ton école dans ta poche"`)
        .setDescription('Le panel étudiant s\'installe sur ton téléphone et s\'enrichit : annuaire avec photos, événements et agenda au mois.')
        .setColor(0x5865f2)
        .setThumbnail(client.user?.displayAvatarURL() || null)
        .addFields(
            {
                name: '🌐 Le panel étudiant',
                value:
                    '• `/panel` te donne le lien, en message visible par toi seul.\n' +
                    '• **Installe-le** sur ton téléphone, comme une application.\n' +
                    '• Service non officiel, sans lien avec MyGES ni le Réseau GES.' +
                    (panelLink ? `\n• Accès : ${panelLink}` : ''),
            },
            {
                name: '👥 Annuaire et équipes',
                value:
                    '• Ta classe et tes intervenants, avec leurs photos, relayées sans jamais être enregistrées.\n' +
                    '• Les équipes ont leur propre page dans chaque projet.',
            },
            {
                name: '🗓️ Agenda et événements',
                value:
                    '• **Vue au mois** : repère d\'un coup d\'œil tes semaines de cours, pratique en alternance.\n' +
                    '• **Export** de 12 semaines vers Google Agenda ou ton téléphone.\n' +
                    '• Un écran pour tous les **événements** de l\'école.',
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
