import { ChatInputCommandInteraction, Client, EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { Command } from '../core/command';
import { BOT_VERSION } from '../config';

/**
 * Construit l'embed du changelog de la version courante.
 * Partagé entre la commande `/changelog` et l'annonce automatique de MAJ.
 */
export function buildChangelogEmbed(client: Client): EmbedBuilder {
    return new EmbedBuilder()
        .setTitle(`🚀 Mise à jour ${BOT_VERSION} - "Emploi du temps en image"`)
        .setDescription("La plus grosse refonte visuelle du bot : votre emploi du temps devient un véritable planning graphique, et l'affichage des projets et actus a été repensé.")
        .setColor(0x5865f2)
        .setThumbnail(client.user?.displayAvatarURL() || null)
        .addFields(
            { name: '🗓️ Agenda en image', value: '• `/agenda` affiche désormais un **vrai planning en grille** (vues `Jour` et `Semaine`) au lieu de simple texte.\n• Ligne **« maintenant »** en direct et jour courant surligné.' },
            { name: '🎨 Couleur par campus', value: '• Chaque cours est **coloré selon son campus** (Nation, Voltaire, Erard, Rauch...) avec une **légende**.\n• Les **examens** sont automatiquement **encadrés en rouge**.' },
            { name: '🧩 Lisibilité améliorée', value: '• Les cours simultanés sont **séparés automatiquement** (fini les blocs superposés).\n• Le texte **s\'adapte** à la taille du bloc pour rester lisible.' },
            { name: '📂 Projets & 📰 Actus', value: '• `/projets` : **compte à rebours en direct** sur chaque échéance, affichage aéré et trié par urgence.\n• `/news` : présentation nettoyée, dates dynamiques et extrait de contenu.' },
            { name: '🔒 Fiabilité (sous le capot)', value: '• **Reconnexion automatique** quand la session MyGes expire.\n• Chiffrement des identifiants renforcé et détection automatique de l\'année scolaire.' }
        )
        .setFooter({ text: "Merci d'utiliser MyGes Bot ! 🎓" })
        .setTimestamp();
}

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('changelog')
        .setDescription('Affiche les dernières nouveautés du bot (v2.0)'),

    execute: async (interaction: ChatInputCommandInteraction) => {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await interaction.editReply({ embeds: [buildChangelogEmbed(interaction.client)] });
    },
};

export default command;
