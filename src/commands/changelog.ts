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
        .setTitle(`🚀 Mise à jour ${BOT_VERSION} - "Plus rapide, plus solide"`)
        .setDescription("Pas de nouvelle commande cette fois : cette version s'attaque à **tout ce qui coinçait**. Le bot répond plus vite, ne reste plus bloqué sur « réfléchit… », et ne s'arrête plus tout seul.")
        .setColor(0x5865f2)
        .setThumbnail(client.user?.displayAvatarURL() || null)
        .addFields(
            {
                name: '⚡ `/agenda` et `/notes` nettement plus rapides',
                value:
                    "• Naviguer entre les semaines ne relance plus une requête MyGes **à chaque clic** : l'emploi du temps que tu viens de consulter reste en mémoire une minute.\n" +
                    '• Les images (agenda, graphiques de notes) sont désormais dessinées **en parallèle**, sur des threads dédiés.\n' +
                    '• Résultat : même quand plusieurs personnes utilisent le bot en même temps, les commandes ne se marchent plus dessus.',
            },
            {
                name: '🩹 Fini les commandes bloquées sur « réfléchit… »',
                value:
                    "• Quand une commande échouait, elle restait **indéfiniment** en attente. Elle affiche maintenant un vrai message d'erreur.\n" +
                    '• `/absences` pouvait tomber en panne silencieuse : corrigé.\n' +
                    '• Si MyGes ne répond plus, la commande **abandonne proprement** au lieu de patienter sans fin.',
            },
            {
                name: "🛡️ Le bot ne s'arrête plus tout seul",
                value:
                    '• Une simple erreur réseau au mauvais moment pouvait **couper le bot net**. Il encaisse désormais et continue de tourner.\n' +
                    '• Après un redémarrage, les commandes sont **utilisables immédiatement**, sans attendre la reconnexion de tous les comptes.\n' +
                    '• Arrêts et redémarrages propres côté serveur : plus de statut « en ligne » fantôme.',
            },
            {
                name: '🔐 Tes identifiants mieux protégés',
                value:
                    "• Un bug de concurrence pouvait **effacer des identifiants enregistrés** lorsqu'une connexion tombait pendant une vérification des projets : on se retrouvait déconnecté sans raison. Corrigé.\n" +
                    '• Le fichier de sauvegarde est maintenant **lisible par le bot seul** sur le serveur.\n' +
                    '• Pour rappel : identifiants chiffrés en **AES-256-GCM**, token jamais transmis ailleurs qu\'à MyGes.',
            },
            {
                name: '🧩 Fiches incomplètes enfin tolérées',
                value:
                    '• `/profs`, `/trombi` et `/profil` ne plantent plus quand MyGes renvoie une fiche **sans nom, sans email ou sans photo** : la donnée manquante est simplement signalée.\n' +
                    "• Idem pour `/news`, `/prochain` et `/projets` lorsque l'école renvoie une réponse vide.",
            },
            {
                name: '🛠️ Sous le capot',
                value:
                    '• Blocage du bot pendant le dessin des images : **960 ms → 3 ms** sur 8 rendus simultanés.\n' +
                    '• Le fichier de données n\'est plus relu et réanalysé à chaque interaction.\n' +
                    '• Toutes les dépendances à jour : **0 faille connue** (5 auparavant, dont 3 critiques).\n' +
                    '• Le bot est prêt pour **Node.js 26**.',
            },
            {
                name: '✅ Aucune action requise',
                value: '• Rien à reconfigurer : `/config`, tes salons et ton compte de référence sont conservés tels quels.',
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
