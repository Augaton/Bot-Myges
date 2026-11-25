import {
    ActionRowBuilder, ButtonBuilder, ButtonInteraction, ButtonStyle, ChatInputCommandInteraction, EmbedBuilder,
    MessageFlags, SlashCommandBuilder,
} from 'discord.js';
import { Command } from '../core/command';
import { BOT_VERSION } from '../config';
import { buildChangelogEmbed } from '../utils/changelog';
import { logError } from '../utils/logger';
import { shareButton, shareRow } from '../utils/share';

// Bouton « Nouveautés », routé globalement (voir index.ts) : il marche encore
// longtemps après l'affichage de l'aide, sans collecteur.
export const HELP_NEWS_ID = 'help:nouveautes';

/** Durée lisible : « 3 j 4 h », « 2 h 15 min », « 42 min ». */
export function formatUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d} j ${h} h`;
    if (h > 0) return `${h} h ${m} min`;
    return `${m} min`;
}

// L'état de MyGes est gardé une minute : /help répond tout de suite, et Kordis
// n'est pas sollicité à chaque affichage de l'aide.
const STATUS_TTL_MS = 60_000;
let lastStatus: { at: number; text: string } | null = null;

/** État de l'API MyGes. Délai borné : une API qui ne répond plus est justement ce qu'on veut voir. */
async function mygesStatus(): Promise<string> {
    if (lastStatus && Date.now() - lastStatus.at < STATUS_TTL_MS) return lastStatus.text;
    let text: string;
    try {
        const start = Date.now();
        const response = await fetch('https://api.kordis.fr', { method: 'HEAD', signal: AbortSignal.timeout(5000) });
        const ms = Date.now() - start;
        await response.body?.cancel().catch(() => {});
        // 200, 401 ou 403 : le serveur répond, donc il est en ligne.
        text = response.status < 500 ? `🟢 en ligne (${ms} ms)` : `🟠 instable (erreur ${response.status})`;
    } catch (e) {
        logError('AIDE', "L'API MyGes ne répond pas :", e);
        text = '🔴 ne répond pas';
    }
    lastStatus = { at: Date.now(), text };
    return text;
}

/** Clic sur « Nouveautés » : le changelog, visible par l'étudiant seul, partageable. */
export async function handleHelpButton(i: ButtonInteraction) {
    await i.reply({ embeds: [buildChangelogEmbed(i.client)], components: [shareRow()], flags: MessageFlags.Ephemeral }).catch((e) => {
        logError('AIDE', 'Affichage des nouveautés impossible :', e);
    });
}

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('Les commandes, l\'état de MyGES et les nouveautés'),

    execute: async (interaction: ChatInputCommandInteraction) => {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const embed = new EmbedBuilder()
            .setTitle('🤖 Guide des Commandes')
            .setDescription('Voici tout ce que je peux faire pour toi :')
            .setColor(0x5865f2)
            .setThumbnail(interaction.client.user?.displayAvatarURL() || null)
            .addFields(
                { name: '🔐 Compte', value: '` /login ` : Se connecter (via formulaire sécurisé)\n` /panel ` : Le panel web et ton abonnement calendrier\n` /logout ` : Se déconnecter et supprimer tes données' },
                { name: '📅 Au quotidien', value: '` /agenda ` : Ta semaine en image, le prochain cours en tête\n` /notes ` : Tes moyennes par matière en image' },
                { name: '🔒 Pour toi seul', value: '` /alertes ` : Notes, absences, rendus et agenda en MP\n` /campus ` : Adresses et codes d\'accès des campus' },
                { name: '🌐 Dans le panel', value: 'Absences, projets, documents, profil, annuaire, actualités et événements : ` /panel ` te donne le lien.' },
                { name: '⚙️ Administrateurs', value: '` /config ` : Configurer le bot pour ce serveur' },
                { name: '🖥️ État', value: `MyGES : ${await mygesStatus()}\nBot ${BOT_VERSION}, en ligne depuis ${formatUptime(process.uptime())}` },
                { name: '💡 Astuce', value: "Mes réponses ne sont visibles que par toi. Le bouton **📢 Partager dans le salon** en publie une copie pour tout le monde, pratique pour montrer un emploi du temps sans que l'autre ait à lancer la commande." },
            )
            .setFooter({ text: 'Bot développé avec ❤️ (Amour si vous avez pas saisi)' });

        await interaction.editReply({
            embeds: [embed],
            components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId(HELP_NEWS_ID).setLabel(`🆕 Nouveautés ${BOT_VERSION}`).setStyle(ButtonStyle.Primary),
                shareButton(),
            )],
        });
    },
};

export default command;
