// Tableau de bord : un message public avec un bouton par commande, publié par un
// administrateur avec /config. Chaque clic lance la commande pour la personne qui
// clique, et la réponse n'est visible que par elle : personne n'a de commande à
// deviner ni à taper. Les boutons sont routés globalement (voir index.ts) : ils
// marchent encore des mois après la publication, même après un redémarrage.
import {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder, Guild, RESTJSONErrorCodes,
} from 'discord.js';
import { panelPublicUrl } from '../config';
import { log, logError } from '../utils/logger';
import { loadData, saveData } from './store';
import type { GuildConfig } from './store';

export const HUB_PREFIX = 'hub:';

// Commandes proposées, rangée par rangée. Jamais de commande d'administration :
// le message est visible par tout le serveur.
const ROWS: { command: string; label: string; style: ButtonStyle }[][] = [
    [
        { command: 'login', label: '🔐 Se connecter', style: ButtonStyle.Success },
        { command: 'agenda', label: '📅 Agenda', style: ButtonStyle.Primary },
        { command: 'notes', label: '📊 Notes', style: ButtonStyle.Primary },
        { command: 'panel', label: '🌐 Panel', style: ButtonStyle.Primary },
    ],
    [
        { command: 'alertes', label: '🔔 Alertes', style: ButtonStyle.Secondary },
        { command: 'campus', label: '🏫 Campus', style: ButtonStyle.Secondary },
        { command: 'help', label: '❓ Aide', style: ButtonStyle.Secondary },
        { command: 'logout', label: '🚪 Se déconnecter', style: ButtonStyle.Secondary },
    ],
];
const COMMANDS = new Set(ROWS.flat().map((b) => b.command));

/** Commande lancée par un bouton du tableau de bord, ou null si ce n'en est pas un. */
export function hubCommand(customId: string): string | null {
    if (!customId.startsWith(HUB_PREFIX)) return null;
    const name = customId.slice(HUB_PREFIX.length);
    return COMMANDS.has(name) ? name : null;
}

/** Bouton « Se connecter » : aussi proposé à qui doit se (re)connecter, n'importe où. */
export const loginButton = () =>
    new ButtonBuilder().setCustomId(`${HUB_PREFIX}login`).setLabel('🔐 Se connecter').setStyle(ButtonStyle.Success);

/** Le message du tableau de bord, tel que publié ou remis à jour. */
export function hubMessage(client: Client) {
    // Sans adresse publique, le bouton du panel ne mènerait qu'à un refus.
    const panel = !!panelPublicUrl();
    const lines = [
        'Clique sur un bouton : je réponds **à toi seul**, personne d\'autre ne voit tes notes ni ton agenda.',
        '',
        '🔐 **Se connecter** : la première fois, avec ton identifiant MyGES (`p.nom`).',
        '📅 **Agenda** et 📊 **Notes** : ta semaine et tes moyennes en image.',
        panel ? '🌐 **Panel** : absences, projets, documents et tout le reste, sur le site, sans retaper ton mot de passe.' : null,
        '🔔 **Alertes** : nouvelles notes, absences, rendus et changements d\'agenda en MP.',
        '🏫 **Campus** : adresses et codes d\'accès.',
    ];
    const embed = new EmbedBuilder()
        .setTitle('🎓 Ton espace MyGES')
        .setDescription(lines.filter((l) => l !== null).join('\n'))
        .setColor(0x5865f2)
        .setThumbnail(client.user?.displayAvatarURL() || null)
        .setFooter({ text: 'Les commandes (/agenda, /notes…) marchent aussi. Service non officiel, sans lien avec MyGES.' });
    const components = ROWS.map((row) => new ActionRowBuilder<ButtonBuilder>().addComponents(
        row.filter((b) => panel || b.command !== 'panel').map((b) =>
            new ButtonBuilder().setCustomId(`${HUB_PREFIX}${b.command}`).setLabel(b.label).setStyle(b.style)),
    ));
    return { embeds: [embed], components, allowedMentions: { parse: [] } };
}

// Message ou salon supprimé à la main : il n'y a plus rien à retirer ni à mettre à jour.
const GONE = new Set<unknown>([RESTJSONErrorCodes.UnknownChannel, RESTJSONErrorCodes.UnknownMessage]);
const gone = (e: unknown) => GONE.has((e as { code?: unknown } | null)?.code);

async function deleteMessage(client: Client, channelId?: string, messageId?: string) {
    if (!channelId || !messageId) return;
    try {
        const channel = await client.channels.fetch(channelId);
        if (channel?.isTextBased()) await channel.messages.delete(messageId);
    } catch (e) {
        if (!gone(e)) logError('HUB', `Ancien tableau de bord ${messageId} non supprimé :`, e);
    }
}

/**
 * Publie le tableau de bord dans ce salon, en bas, puis retire le précédent.
 * Renvoie le motif d'un échec (le précédent reste alors en place). L'appelant enregistre `cfg`.
 */
export async function publishHub(guild: Guild, cfg: GuildConfig, channelId: string): Promise<string | null> {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isSendable()) return 'salon introuvable, ou sans messages';
    let messageId: string;
    try {
        messageId = (await channel.send(hubMessage(guild.client))).id;
    } catch (e) {
        logError('HUB', `${guild.name} : publication dans ${channelId} impossible :`, e);
        return 'le bot n\'a pas pu y écrire';
    }
    const previous = { channelId: cfg.hubChannelId, messageId: cfg.hubMessageId };
    cfg.hubChannelId = channelId;
    cfg.hubMessageId = messageId;
    await deleteMessage(guild.client, previous.channelId, previous.messageId);
    return null;
}

/** Retire le tableau de bord (message supprimé, réglage effacé). L'appelant enregistre `cfg`. */
export async function removeHub(client: Client, cfg: GuildConfig) {
    const { hubChannelId, hubMessageId } = cfg;
    delete cfg.hubChannelId;
    delete cfg.hubMessageId;
    await deleteMessage(client, hubChannelId, hubMessageId);
}

/**
 * Au démarrage : remet chaque tableau de bord à jour, pour qu'une nouvelle version
 * y ajoute ses boutons. Un tableau supprimé à la main est oublié.
 */
export async function refreshHubs(client: Client) {
    const data = loadData();
    for (const [guildId, cfg] of Object.entries(data.guilds)) {
        if (!cfg.hubChannelId || !cfg.hubMessageId) continue;
        try {
            const channel = await client.channels.fetch(cfg.hubChannelId);
            if (!channel?.isTextBased()) throw new Error('salon sans messages');
            await channel.messages.edit(cfg.hubMessageId, hubMessage(client));
        } catch (e) {
            if (!gone(e)) {
                logError('HUB', `Serveur ${guildId} : mise à jour du tableau de bord impossible :`, e);
                continue;
            }
            delete cfg.hubChannelId;
            delete cfg.hubMessageId;
            saveData(data);
            log('HUB', `Serveur ${guildId} : tableau de bord supprimé à la main, réglage oublié.`);
        }
    }
}
