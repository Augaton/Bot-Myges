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
        .setTitle(`🚀 Mise à jour ${BOT_VERSION} - "Tes documents sur Discord"`)
        .setDescription('Tes **supports de cours** et **documents administratifs** arrivent sur Discord, tes **absences** te sont signalées en MP et tes **TP** rejoignent tes projets.')
        .setColor(0x5865f2)
        .setThumbnail(client.user?.displayAvatarURL() || null)
        .addFields(
            {
                name: '📚 Nouveau : `/documents`',
                value:
                    '• Choisis une matière, puis un fichier : je te l\'envoie ici, **visible par toi seul**.\n' +
                    '• Certificats et bulletins sont dans **Documents administratifs**.',
            },
            {
                name: '🚫 Nouveau : absences en MP',
                value: '• Une absence enregistrée sur MyGes ? Je te préviens par MP (vérifié toutes les heures). Activé par défaut, à couper dans `/alertes`.',
            },
            {
                name: '🧪 Les TP rejoignent les projets',
                value: '• `/projets` et les rappels de rendus (la veille, puis 2 h avant) comptent maintenant aussi tes **travaux pratiques**.',
            },
            {
                name: '🛠️ Corrections',
                value:
                    '• `/absences` affiche les **plus récentes d\'abord** et compte celles qui ne sont pas justifiées.\n' +
                    '• `/news` affiche le résumé des actualités et le vrai total.\n' +
                    '• Les **accents** ne disparaissent plus des actualités et consignes.\n' +
                    '• Une réponse vide de MyGes ne s\'affiche plus comme une erreur.\n' +
                    '• Un refus passager de MyGes n\'est plus pris pour un mot de passe changé.',
            },
            {
                name: '🔐 Sécurité',
                value:
                    '• `/trombi` et `/profs` ne proposent plus de publier la fiche d\'une personne dans un salon.\n' +
                    '• `/campus` est réservé aux étudiants qui ont cours sur ces campus, vérifié sur ton agenda MyGes.\n' +
                    '• **Partager** demande le droit d\'écrire dans le salon.\n' +
                    '• Un mot de passe contenant `€` ou un emoji fonctionne enfin.',
            },
            {
                name: '✅ Aucune action requise',
                value: '• Rien à reconfigurer. Les absences déjà connues ne seront pas envoyées d\'un coup.',
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
