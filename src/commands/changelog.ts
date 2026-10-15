import { ChatInputCommandInteraction, Client, EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { Command } from '../core/command';
import { BOT_VERSION } from '../config';
import { shareRow } from '../utils/share';

/**
 * Construit l'embed du changelog de la version courante.
 * Partagé entre la commande `/changelog` et l'annonce automatique de MAJ.
 */
export function buildChangelogEmbed(client: Client): EmbedBuilder {
    return new EmbedBuilder()
        .setTitle(`🚀 Mise à jour ${BOT_VERSION} - "Ton agenda sous surveillance"`)
        .setDescription("Le bot te prévient maintenant en **message privé** quand ton emploi du temps change, et peut t'envoyer ton **programme chaque matin**. Les alertes de notes sont aussi plus fiables.")
        .setColor(0x5865f2)
        .setThumbnail(client.user?.displayAvatarURL() || null)
        .addFields(
            {
                name: '🗓️ Nouveau : changements d\'agenda en MP',
                value:
                    '• Un cours de la semaine à venir est **annulé**, **déplacé**, **ajouté** ou **change de salle** ? Je t\'envoie un MP avec l\'avant et l\'après (vérifié toutes les heures).\n' +
                    '• Activé par défaut, à couper dans `/alertes`. Tes cours mémorisés sont **chiffrés**.',
            },
            {
                name: '☀️ Nouveau : programme du matin',
                value: '• Vers **7 h**, un MP avec tes cours du jour, leurs horaires et leurs salles. À activer dans `/alertes`.',
            },
            {
                name: '📝 Notes : fini les fausses alertes',
                value:
                    '• Quand l\'école retire ou insère une note, les autres ne sont plus annoncées comme nouvelles.\n' +
                    '• Te reconnecter avec **un autre compte MyGes** ne t\'envoie plus toutes ses notes d\'un coup.',
            },
            {
                name: '🔐 Sécurité',
                value: '• `/login` limite aussi les essais **par identifiant MyGes** : multiplier les comptes Discord ne permet plus d\'insister sur le compte de quelqu\'un.',
            },
            {
                name: '⚙️ Pour les admins',
                value:
                    '• Les alertes de nouveaux projets partent **dès le démarrage** du bot, sans attendre une heure.\n' +
                    '• La configuration d\'un serveur que le bot a quitté est supprimée automatiquement.',
            },
            {
                name: '✅ Aucune action requise',
                value: '• Rien à reconfigurer : ta connexion, `/config`, tes salons et tes réglages d\'alertes sont conservés.',
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
