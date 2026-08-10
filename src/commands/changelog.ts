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
        .setTitle(`🚀 Mise à jour ${BOT_VERSION} - "Multi-serveurs"`)
        .setDescription("Version majeure : **un seul bot pour toutes les promos**. Chaque serveur a désormais sa propre configuration, réglable directement depuis Discord.")
        .setColor(0x5865f2)
        .setThumbnail(client.user?.displayAvatarURL() || null)
        .addFields(
            { name: '🏫 Un bot, plusieurs serveurs', value: '• Fini un bot par promo : le même bot gère **plusieurs serveurs**, chacun avec **sa propre configuration** (salons, compte de référence, alertes).\n• Les projets annoncés sont **cloisonnés par serveur** : aucun mélange entre promos.' },
            { name: '⚙️ Configuration en jeu : `/config`', value: '• Un **panneau interactif** pour tout régler : sélection des salons et du compte de référence **en quelques clics**.\n• Plus besoin de toucher au code ou de redémarrer le bot.\n• **Réservé aux administrateurs** : la commande est invisible et inaccessible aux autres.' },
            { name: '👤 Compte MyGes de référence', value: '• Chaque serveur choisit **quel compte** alimente ses alertes projets.\n• 🔐 **Ton compte et lui seul** : un administrateur ne peut **pas** désigner le compte de quelqu\'un d\'autre, tes données ne peuvent donc pas être publiées sans ton accord.\n• `/logout` te retire automatiquement comme référence **sur tous les serveurs**.' },
            { name: '🔒 Sécurité', value: '• Ton **token MyGes** n\'est plus jamais transmis à un serveur autre que MyGes (vérification stricte du domaine).\n• Identifiants toujours chiffrés (**AES-256-GCM**) et **reconnexion automatique** si la session expire.' },
            { name: '⚡ Performances', value: '• `/trombi` et `/profs` : les photos sont **mises en cache** — navigation bien plus fluide, fini le retéléchargement à chaque clic.\n• Les serveurs partageant un même compte de référence ne déclenchent plus qu\'**une seule requête** au lieu d\'une par serveur.' },
            { name: '🛠️ Fiabilité', value: '• Les nouveaux projets sont **enregistrés immédiatement** : plus d\'alertes en double.\n• Sauvegarde plus sûre (écriture atomique) et **logs serveur détaillés**.' },
            { name: '⚠️ Action requise', value: '• Un **administrateur** doit lancer **`/config`** sur chaque serveur pour (ré)activer les alertes projets et les annonces de mise à jour.' }
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
