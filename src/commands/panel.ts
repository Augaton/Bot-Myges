import {
    ActionRowBuilder, ButtonBuilder, ButtonInteraction, ButtonStyle, ChatInputCommandInteraction, EmbedBuilder,
    InteractionEditReplyOptions, MessageFlags, SlashCommandBuilder,
} from 'discord.js';
import { Command } from '../core/command';
import { getSession } from '../core/store';
import { panelPublicUrl } from '../config';
import { createFeed, feedSecret, refreshFeed, removeFeed } from '../tasks/agendaFeeds';
import { tooManyClicks } from '../utils/collector';
import { logError } from '../utils/logger';
import { apiErrorMessage, noSessionMessage } from '../utils/replies';

// Boutons de l'abonnement d'agenda. Routés globalement (voir index.ts) : ils
// fonctionnent sans collecteur, donc encore après un redémarrage du bot.
export const FEED_PREFIX = 'feed:';
const FEED_ACTIONS = ['lien', 'nouveau', 'supprimer'] as const;
type FeedAction = (typeof FEED_ACTIONS)[number];

const feedButton = (action: FeedAction, label: string, style: ButtonStyle) =>
    new ButtonBuilder().setCustomId(`${FEED_PREFIX}${action}`).setLabel(label).setStyle(style);

/** Réponse à un bouton d'abonnement : le lien et ses réglages, ou un message. */
async function feedReply(userId: string, action: FeedAction): Promise<string | InteractionEditReplyOptions> {
    if (action === 'supprimer') {
        return removeFeed(userId) ? '🗑️ Abonnement supprimé : son lien ne fonctionne plus.' : 'Tu n\'as pas d\'abonnement.';
    }
    const base = panelPublicUrl().replace(/\/+$/, '');
    if (!base) return 'Le panel n\'a pas d\'adresse publique : l\'administrateur doit renseigner PANEL_PUBLIC_URL.';
    const token = await getSession(userId);
    if (!token) return noSessionMessage(userId);

    const secret = (action !== 'nouveau' && feedSecret(userId)) || createFeed(userId);
    try {
        await refreshFeed(userId, secret, token);
    } catch (e) {
        logError('AGENDA', 'Préparation de l\'abonnement impossible :', e);
        return apiErrorMessage(e, 'ton agenda');
    }
    const link = `${base}/agenda/${secret}.ics`;
    return {
        content: '',
        embeds: [new EmbedBuilder()
            .setTitle('📅 Abonnement à ton agenda')
            .setColor(0x5865f2)
            .setDescription(
                `${link}\n\nColle ce lien dans ton calendrier :\n` +
                '• **Google Agenda** (sur ordinateur) : Autres agendas → **+** → À partir de l\'URL.\n' +
                '• **iPhone** : Réglages → Calendrier → Comptes → Ajouter un compte → Autre → Calendrier avec abonnement.\n\n' +
                'Les 12 prochaines semaines, préparées toutes les 30 minutes. Google Agenda les relit à son rythme, souvent quelques heures.',
            )
            .addFields({ name: '🔒 Garde-le pour toi', value: 'Ce lien donne accès à ton agenda. « Nouveau lien » le remplace, « Supprimer » le coupe.' })],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
            feedButton('nouveau', '🔄 Nouveau lien', ButtonStyle.Secondary),
            feedButton('supprimer', '🗑️ Supprimer l\'abonnement', ButtonStyle.Danger),
        )],
    };
}

/** Clic sur un bouton d'abonnement : la réponse n'est visible que par l'étudiant qui a cliqué. */
export async function handleFeedButton(i: ButtonInteraction) {
    const action = i.customId.slice(FEED_PREFIX.length) as FeedAction;
    if (!FEED_ACTIONS.includes(action)) return;
    if (await tooManyClicks(i)) return;
    try {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        await i.editReply(await feedReply(i.user.id, action));
    } catch (e) {
        logError('AGENDA', 'Bouton d\'abonnement :', e);
        await i.editReply('❌ Une erreur est survenue. Réessaie dans un instant.').catch(() => {});
    }
}

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('panel')
        .setDescription('Lien du panel étudiant et de ton abonnement calendrier'),

    execute: async (interaction: ChatInputCommandInteraction) => {
        const url = panelPublicUrl();
        if (!url) {
            return interaction.reply({ content: '🌐 Le panel étudiant n\'est pas disponible pour le moment.', flags: MessageFlags.Ephemeral });
        }
        const embed = new EmbedBuilder()
            .setTitle('🌐 Panel étudiant')
            .setDescription(
                `**[Ouvrir le panel](${url})**\n${url}\n\n` +
                'Connecte-toi avec ton identifiant MyGES : ton mot de passe sert une seule fois à vérifier ton compte et n\'est jamais enregistré.\n\n' +
                '📅 **Abonnement calendrier** : un lien à coller dans Google Agenda ou ton iPhone, ton agenda s\'y met à jour tout seul.'
            )
            .setColor(0x5865f2)
            .setFooter({ text: 'Service non officiel, sans lien avec MyGES ni le Réseau GES.' });
        await interaction.reply({
            embeds: [embed],
            components: [new ActionRowBuilder<ButtonBuilder>().addComponents(feedButton('lien', '📅 Mon lien d\'abonnement', ButtonStyle.Primary))],
            flags: MessageFlags.Ephemeral,
        });
    },
};

export default command;
