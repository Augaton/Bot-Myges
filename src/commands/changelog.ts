import { ChatInputCommandInteraction, Client, EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { Command } from '../core/command';
import { BOT_VERSION } from '../config';
import { shareRow } from '../utils/share';

/**
 * Construit l'embed du changelog de la version courante.
 * Partagé entre la commande `/changelog` et l'annonce automatique de MAJ.
 */
export function buildChangelogEmbed(client: Client): EmbedBuilder {
    // Annonce publique : le lien du panel n'y figure que s'il a été renseigné.
    const url = process.env.PANEL_PUBLIC_URL ?? '';
    const panelLink = url.startsWith('https://') ? url : '';
    return new EmbedBuilder()
        .setTitle(`🚀 Mise à jour ${BOT_VERSION} - "Le panel étudiant"`)
        .setDescription('MyGes Bot a maintenant son **site web** : ton agenda, tes notes, tes projets et tes documents au même endroit, sur téléphone comme sur ordinateur.')
        .setColor(0x5865f2)
        .setThumbnail(client.user?.displayAvatarURL() || null)
        .addFields(
            {
                name: '🌐 Nouveau : le panel étudiant',
                value:
                    '• Agenda en grille, notes, absences, projets avec leurs équipes, documents et actualités.\n' +
                    '• Clique sur un cours pour voir sa salle, son syllabus et ses supports.\n' +
                    '• Connexion avec ton identifiant MyGES : ton mot de passe sert une seule fois et n\'est **jamais enregistré**.\n' +
                    '• Service non officiel, sans lien avec MyGES ni le Réseau GES.' +
                    (panelLink ? `\n• Accès : ${panelLink}` : ''),
            },
            {
                name: '📚 Sur Discord',
                value:
                    '• `/documents` : supports de cours et documents annuels, envoyés visibles par toi seul.\n' +
                    '• Tes **absences** te sont signalées en MP, à couper dans `/alertes`.\n' +
                    '• `/projets` et les rappels comptent aussi tes **travaux pratiques**.',
            },
            {
                name: '🛠️ Corrections',
                value:
                    '• `/prochain` cherche jusqu\'à 6 semaines, pratique en alternance.\n' +
                    '• `/profil` affiche enfin ta classe, `/news` le texte des actualités, et `/absences` les plus récentes d\'abord.\n' +
                    '• Les **accents** ne disparaissent plus, et un mot de passe avec `€` ou un emoji fonctionne.\n' +
                    '• Un refus passager de MyGes n\'est plus pris pour un mot de passe changé.',
            },
            {
                name: '🔐 Sécurité',
                value:
                    '• `/trombi` et `/profs` ne proposent plus de publier la fiche d\'une personne dans un salon.\n' +
                    '• `/campus` est réservé aux étudiants qui ont cours sur ces campus.\n' +
                    '• **Partager** demande le droit d\'écrire dans le salon.',
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
