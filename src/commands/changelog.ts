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
        .setTitle(`🚀 Mise à jour ${BOT_VERSION} - "Tes notes en MP, ton agenda à l'heure"`)
        .setDescription("Le bot te prévient maintenant **en message privé** : nouvelles notes, rendus qui approchent. Ton emploi du temps s'exporte dans ton agenda, retrouve ses bonnes heures, et le bot tient bien mieux la distance.")
        .setColor(0x5865f2)
        .setThumbnail(client.user?.displayAvatarURL() || null)
        .addFields(
            {
                name: '📝 Nouveau : tes notes en MP',
                value:
                    '• Dès qu\'une note apparaît sur MyGes, je t\'envoie un **message privé** avec la matière et la note (vérifié toutes les heures).\n' +
                    '• Examens et moyennes définitives aussi. Aucune note n\'est stockée en clair.',
            },
            {
                name: '⏰ Nouveau : rappels de rendus',
                value: '• Un MP **la veille** (24 h avant) puis **2 h avant** chaque échéance de projet, avec l\'étape et la consigne.',
            },
            {
                name: '🔔 Nouveau : `/alertes`',
                value:
                    '• Active ou coupe séparément les notes et les rappels, et **teste la réception des MP**.\n' +
                    '• Tout est activé par défaut : pense à accepter les MP des membres du serveur.',
            },
            {
                name: '📥 Nouveau : `/export`',
                value: '• Ton emploi du temps (jusqu\'à 12 semaines) en fichier **.ics**, à importer dans **Google Agenda**, ton **iPhone** ou **Outlook**.',
            },
            {
                name: '🕘 `/agenda` : chaque cours à sa place',
                value:
                    '• Selon le serveur qui héberge le bot, les cours pouvaient être **décalés de 2 h** (un cours de 9 h dessiné sur la ligne de 7 h). Le bot vit désormais **à l\'heure de Paris**, où qu\'il tourne.\n' +
                    '• Heures alignées sur leur ligne, repère à chaque **demi-heure**, et ligne « maintenant » limitée à **la colonne du jour**.',
            },
            {
                name: '🩹 Fini les « erreurs 500 » en rafale',
                value:
                    '• Quand MyGes a un raté passager, le bot **réessaie tout seul** avant de t\'afficher une erreur.\n' +
                    '• Les messages disent **ce qui se passe** : MyGes en panne, trop lent, ou mot de passe changé.\n' +
                    '• Ton accès MyGes est **renouvelé avant d\'expirer**.',
            },
            {
                name: '⚡ Plus rapide',
                value:
                    '• `/notes` et `/profil` restent en mémoire quelques instants : les relancer est **instantané**.\n' +
                    '• Après un redémarrage, ta session revient **dès ta première commande**, sans attendre les autres, et plus jamais de « connecte-toi » à tort si MyGes était en panne.',
            },
            {
                name: '🛡️ Un bot qui tient sur la durée',
                value:
                    '• Le dessin des images consomme **nettement moins de mémoire**.\n' +
                    '• En cas de pépin, le bot **redémarre automatiquement** ; si la connexion à Discord se bloque, il se relance tout seul.',
            },
            {
                name: '🔐 Sécurité',
                value:
                    '• **Chiffrement renforcé** de tes identifiants (clé dérivée par scrypt), appliqué automatiquement : rien à refaire.\n' +
                    '• `/login` limite les **tentatives répétées** : ton compte MyGes ne peut pas être verrouillé à force d\'essais via le bot.\n' +
                    '• Dépendances à jour : **0 faille connue**. `/campus` n\'a plus de bouton de partage.',
            },
            {
                name: '⚙️ Pour les admins',
                value: '• `/config` prévient si le bot **n\'a pas le droit d\'écrire** dans le salon choisi (sinon, les alertes échouaient sans bruit).',
            },
            {
                name: '✅ Aucune action requise',
                value: '• Rien à reconfigurer : ta connexion, `/config`, tes salons et ton compte de référence sont conservés.',
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
