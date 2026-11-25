import {
    ActionRowBuilder, ButtonBuilder, ButtonInteraction, ButtonStyle, EmbedBuilder,
    InteractionEditReplyOptions, MessageFlags, SlashCommandBuilder,
} from 'discord.js';
import { Command, CommandInteraction } from '../core/command';
import { getSession, hasAccount, loadData } from '../core/store';
import { panelPublicUrl, TICKETS_DIR } from '../config';
import { decrypt } from '../crypto';
import { createTicket } from '../utils/panelTicket';
import { createFeed, feedSecret, refreshFeed, removeFeed } from '../tasks/agendaFeeds';
import { tooManyClicks } from '../utils/collector';
import { log, logError } from '../utils/logger';
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

/**
 * Adresse du panel qui connecte directement l'étudiant avec la session du bot (voir
 * utils/panelTicket), ou null s'il n'est pas connecté au bot ou que MyGES ne répond pas.
 */
async function connectedLink(userId: string, base: string): Promise<string | null> {
    if (!hasAccount(userId)) return null;
    const token = await getSession(userId);
    const creds = loadData().users[userId];
    if (!token || !creds) return null;
    try {
        const secret = createTicket(TICKETS_DIR, userId, token, decrypt(creds.user));
        return `${base.replace(/\/+$/, '')}/#connexion=${secret}`;
    } catch (e) {
        logError('PANEL', 'Lien de connexion au panel impossible :', e);
        return null;
    }
}

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('panel')
        .setDescription('Lien du panel étudiant et de ton abonnement calendrier'),

    execute: async (interaction: CommandInteraction) => {
        const url = panelPublicUrl();
        if (!url) {
            return interaction.reply({ content: '🌐 Le panel étudiant n\'est pas disponible pour le moment.', flags: MessageFlags.Ephemeral });
        }
        // Le ticket peut demander de rouvrir la session MyGES : plus de 3 s parfois.
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const link = await connectedLink(interaction.user.id, url);
        if (link) log('PANEL', `Lien de connexion au panel créé pour ${interaction.user.id}.`);
        const embed = new EmbedBuilder()
            .setTitle('🌐 Panel étudiant')
            .setDescription(
                (link
                    ? '**🔓 Ouvrir le panel** t\'y connecte directement avec ton compte du bot, sans mot de passe.\n' +
                      'Ce bouton est personnel : il sert une seule fois, dans les 10 minutes. Ne le partage pas.\n\n' +
                      `Adresse du panel : ${url}`
                    : `**[Ouvrir le panel](${url})**\n${url}\n\n` +
                      'Connecte-toi avec ton identifiant MyGES : ton mot de passe sert une seule fois à vérifier ton compte et n\'est jamais enregistré.') +
                '\n\n📅 **Abonnement calendrier** : un lien à coller dans Google Agenda ou ton iPhone, ton agenda s\'y met à jour tout seul.'
            )
            .setColor(0x5865f2)
            .setFooter({ text: 'Service non officiel, sans lien avec MyGES ni le Réseau GES.' });
        const buttons = new ActionRowBuilder<ButtonBuilder>();
        if (link) buttons.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(link).setLabel('🔓 Ouvrir le panel'));
        buttons.addComponents(feedButton('lien', '📅 Mon lien d\'abonnement', link ? ButtonStyle.Secondary : ButtonStyle.Primary));
        await interaction.editReply({ embeds: [embed], components: [buttons] });
    },
};

export default command;
