import {
    ChatInputCommandInteraction, EmbedBuilder, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder,
} from 'discord.js';
import { Command } from '../core/command';
import { BOT_VERSION, isBotOwner } from '../config';
import { hasAccount, loadData, SavedData, sessionCount } from '../core/store';
import { md } from '../utils/markdown';

// Une description d'embed tient 4 096 caractères : au-delà, on résume.
const MAX_DESCRIPTION = 3_800;

export interface GuildInfo {
    id: string;
    name: string;
    memberCount: number;
    joinedTimestamp: number | null;
}

const mark = (ok: boolean) => (ok ? '✅' : '❌');

/**
 * Où est le bot, et comment chaque serveur est configuré. Lecture seule : aucune
 * configuration n'est créée ni modifiée, aucun membre n'est listé.
 */
export function serversReport(guilds: GuildInfo[], data: SavedData = loadData()): EmbedBuilder {
    const sorted = [...guilds].sort((a, b) => b.memberCount - a.memberCount || a.name.localeCompare(b.name, 'fr'));
    let description = '';
    let shown = 0;
    for (const g of sorted) {
        // Lu tel quel : getGuildConfig créerait une configuration vide.
        const cfg = data.guilds[g.id];
        const reference = cfg?.referenceUserId
            ? (hasAccount(cfg.referenceUserId) ? '✅' : '⚠️ déconnecté')
            : '❌';
        const joined = g.joinedTimestamp ? ` · arrivé le <t:${Math.floor(g.joinedTimestamp / 1000)}:D>` : '';
        const line = `**${md(g.name)}** · \`${g.id}\`\n`
            + `${g.memberCount} membre${g.memberCount > 1 ? 's' : ''}${joined}\n`
            + `Alertes ${mark(!!cfg?.announcementChannelId)} · Mises à jour ${mark(!!cfg?.updateChannelId)} · Compte de référence ${reference}\n\n`;
        if (description.length + line.length > MAX_DESCRIPTION) break;
        description += line;
        shown++;
    }
    if (shown < sorted.length) description += `… et ${sorted.length - shown} autre${sorted.length - shown > 1 ? 's' : ''} serveur${sorted.length - shown > 1 ? 's' : ''}.`;

    const present = new Set(guilds.map((g) => g.id));
    const orphans = Object.keys(data.guilds).filter((id) => !present.has(id)).length;
    return new EmbedBuilder()
        .setTitle(`🛰️ Serveurs du bot (${guilds.length})`)
        .setColor(0x5865f2)
        .setDescription(description.trim() || 'Le bot n\'est sur aucun serveur.')
        .addFields(
            { name: 'Membres en tout', value: String(guilds.reduce((sum, g) => sum + g.memberCount, 0)), inline: true },
            { name: 'Comptes MyGES liés', value: String(Object.keys(data.users).length), inline: true },
            { name: 'Sessions ouvertes', value: String(sessionCount()), inline: true },
            { name: 'Abonnements d\'agenda', value: String(Object.keys(data.feeds ?? {}).length), inline: true },
            { name: 'Configurations sans serveur', value: orphans ? `${orphans} (serveurs quittés)` : 'Aucune', inline: true },
            { name: 'Version', value: BOT_VERSION, inline: true },
        )
        .setTimestamp();
}

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('serveurs')
        .setDescription('Serveurs où est le bot et leur configuration (réservé au propriétaire)')
        // Masquée aux membres ordinaires des serveurs ; en message privé avec le bot,
        // le propriétaire la voit toujours. Le vrai contrôle est fait à l'exécution.
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM),

    execute: async (interaction: ChatInputCommandInteraction) => {
        if (!isBotOwner(interaction.user.id)) {
            return interaction.reply({ content: '❌ Commande réservée au propriétaire du bot.', flags: MessageFlags.Ephemeral });
        }
        const guilds = [...interaction.client.guilds.cache.values()].map((g) => ({
            id: g.id, name: g.name, memberCount: g.memberCount, joinedTimestamp: g.joinedTimestamp ?? null,
        }));
        await interaction.reply({ embeds: [serversReport(guilds)], flags: MessageFlags.Ephemeral });
    },
};

export default command;
