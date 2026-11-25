import { Client, EmbedBuilder } from 'discord.js';
import { BOT_VERSION, panelPublicUrl } from '../config';

/**
 * Construit l'embed du changelog de la version courante.
 * Partagé entre le bouton « Nouveautés » de `/help` et l'annonce automatique de MAJ.
 */
export function buildChangelogEmbed(client: Client): EmbedBuilder {
    // Annonce publique : le lien du panel n'y figure que s'il a été renseigné.
    const panelLink = panelPublicUrl();
    return new EmbedBuilder()
        .setTitle(`🚀 Mise à jour ${BOT_VERSION} - "Moins de commandes, un panel plus complet"`)
        .setDescription('Le bot garde l\'essentiel, le panel prend le reste : campus en couleur, agenda en grille sur téléphone, aperçu des documents.')
        .setColor(0x5865f2)
        .setThumbnail(client.user?.displayAvatarURL() || null)
        .addFields(
            {
                name: '🧹 8 commandes au lieu de 21',
                value:
                    '• `/login`, `/logout`, `/panel`, `/agenda`, `/notes`, `/alertes`, `/campus` et `/help`.\n' +
                    '• Absences, projets, documents, profil, professeurs, trombinoscope et actualités sont dans le panel.',
            },
            {
                name: '🔀 Ce qui a bougé',
                value:
                    '• Le prochain cours s\'affiche en tête de `/agenda`.\n' +
                    '• Ton lien d\'abonnement calendrier : bouton dans `/panel`.\n' +
                    '• L\'état de MyGES et les nouveautés : dans `/help`.',
            },
            {
                name: '🧭 Tableau de bord',
                value:
                    '• Un message à boutons, publié par les administrateurs avec `/config` : se connecter, agenda, notes, panel, alertes… sans taper de commande.\n' +
                    '• Les réponses restent visibles par toi seul.',
            },
            {
                name: '🗓️ Agenda du panel',
                value:
                    '• Une couleur par campus, avec son adresse et l\'itinéraire dans la fiche du cours.\n' +
                    '• Sur téléphone, la semaine s\'affiche en grille, comme sur ordinateur.',
            },
            {
                name: '📚 Notes, projets et documents',
                value:
                    '• Notes : ta moyenne, les matières sous 10 et toutes tes moyennes d\'un coup d\'œil.\n' +
                    '• Projets : un rappel si tu n\'as pas de groupe, les échéances des 30 prochains jours.\n' +
                    '• Documents : les nouveautés en tête, et un aperçu sans télécharger.',
            },
            {
                name: '🌐 Le panel étudiant',
                value:
                    '• Connecté au bot ? Le bouton « Ouvrir le panel » de `/panel` t\'y fait entrer sans mot de passe.\n' +
                    '• Service non officiel, sans lien avec MyGES ni le Réseau GES.' +
                    (panelLink ? `\n• Accès : ${panelLink}` : ''),
            },
            {
                name: '✅ Aucune action requise',
                value: '• Ton abonnement calendrier et tes alertes restent tels quels.',
            }
        )
        .setFooter({ text: "Merci d'utiliser MyGes Bot ! 🎓" })
        .setTimestamp();
}
