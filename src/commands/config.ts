import {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType,
    ChatInputCommandInteraction, EmbedBuilder, Guild, InteractionContextType, MessageFlags,
    PermissionFlagsBits, SlashCommandBuilder,
} from 'discord.js';
import { Command } from '../core/command';
import { getGuildConfig, getSession, hasAccount, loadData, saveData } from '../core/store';
import { ProjectService } from '../myges/services/project';
import { getCurrentYear, isBotOwner } from '../config';
import { log, logError } from '../utils/logger';

// Droits nécessaires au bot dans un salon pour y poster alertes et annonces.
const REQUIRED_PERMS = [
    { flag: PermissionFlagsBits.ViewChannel, label: 'Voir le salon' },
    { flag: PermissionFlagsBits.SendMessages, label: 'Envoyer des messages' },
    { flag: PermissionFlagsBits.EmbedLinks, label: 'Intégrer des liens' },
];

/** Droits manquants au bot dans ce salon (liste vide si tout va bien). */
async function missingPerms(guild: Guild, channelId: string): Promise<string[]> {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) return ['salon introuvable'];
    const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
    const perms = me ? channel.permissionsFor(me) : null;
    if (!perms) return ['droits illisibles'];
    return REQUIRED_PERMS.filter((p) => !perms.has(p.flag)).map((p) => p.label);
}

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('config')
        .setDescription('Configurer le bot pour ce serveur (réservé aux administrateurs)')
        // Pas de permission par défaut côté Discord : elle masquerait la commande
        // au propriétaire du bot lorsqu'il n'est pas admin du serveur. Le contrôle
        // (administrateur OU propriétaire) est fait à l'exécution, ci-dessous.
        .setContexts(InteractionContextType.Guild),

    execute: async (interaction: ChatInputCommandInteraction) => {
        if (!interaction.inCachedGuild()) {
            return interaction.reply({ content: "❌ Cette commande s'utilise uniquement sur un serveur où le bot est présent.", flags: MessageFlags.Ephemeral });
        }

        const isAdmin = interaction.memberPermissions.has(PermissionFlagsBits.Administrator);
        const ownerOverride = !isAdmin && isBotOwner(interaction.user.id);
        if (!isAdmin && !ownerOverride) {
            return interaction.reply({ content: '⛔ Seuls les **administrateurs** du serveur peuvent configurer le bot.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const guild = interaction.guild;
        const guildId = guild.id;
        const adminId = interaction.user.id;
        if (ownerOverride) log('CONFIG', `${guild.name} : accès propriétaire du bot (${interaction.user.tag}, non admin)`);

        // Construit le panneau (embed + contrôles) à partir de la config enregistrée.
        const render = async () => {
            const data = loadData();
            const cfg = getGuildConfig(data, guildId);

            // Le compte de référence ne peut être que celui de l'admin qui configure :
            // désigner le compte d'un tiers exposerait ses données sans son accord.
            const adminHasAccount = !!data.users[adminId];
            const isSelfRef = cfg.referenceUserId === adminId;

            const refStatus = cfg.referenceUserId
                ? hasAccount(cfg.referenceUserId)
                    ? `<@${cfg.referenceUserId}> ✅ connecté`
                    : `<@${cfg.referenceUserId}> ⚠️ non connecté (\`/login\` requis)`
                : '*non défini*';

            const ready = cfg.announcementChannelId && cfg.referenceUserId;

            // Un salon où le bot ne peut pas écrire fait échouer les alertes en
            // silence : on le signale dès la configuration.
            const channelValue = async (id?: string) => {
                if (!id) return '*non défini*';
                const missing = await missingPerms(guild, id);
                return missing.length ? `<#${id}>\n⚠️ Droits manquants pour le bot : ${missing.join(', ')}` : `<#${id}>`;
            };

            const embed = new EmbedBuilder()
                .setTitle('⚙️ Configuration du bot')
                .setDescription(`Réglages propres à **${guild.name}**.\nChaque serveur a sa propre configuration.`)
                .setColor(ready ? 0x2ecc71 : 0xe67e22)
                .addFields(
                    { name: '📢 Salon des alertes projets', value: await channelValue(cfg.announcementChannelId) },
                    { name: '🚀 Salon des mises à jour', value: await channelValue(cfg.updateChannelId) },
                    { name: '👤 Compte MyGes de référence', value: refStatus },
                    {
                        name: '📊 État',
                        value: ready
                            ? '✅ Les alertes projets sont actives sur ce serveur.'
                            : "⚠️ Il faut **un salon d'alertes** ET **un compte de référence** pour activer les alertes.",
                    }
                );

            if (!adminHasAccount) {
                embed.addFields({
                    name: '❗ Connexion requise',
                    value: "Tu dois d'abord te connecter avec `/login` pour pouvoir définir **ton** compte comme référence.",
                });
            }

            embed.setFooter({
                text: ownerOverride
                    ? 'Accès propriétaire du bot · seul ton propre compte peut servir de référence.'
                    : 'Confidentialité : seul ton propre compte peut servir de référence.',
            });

            // Sélecteur : salon des alertes projets
            const announceRow = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
                new ChannelSelectMenuBuilder()
                    .setCustomId('cfg_announce')
                    .setPlaceholder('📢 Choisir le salon des alertes projets')
                    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            );

            // Sélecteur : salon des mises à jour
            const updateRow = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
                new ChannelSelectMenuBuilder()
                    .setCustomId('cfg_update')
                    .setPlaceholder('🚀 Choisir le salon des mises à jour')
                    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            );

            const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId('cfg_ref_self')
                    .setLabel(isSelfRef ? '✅ Ton compte est la référence' : '👤 Utiliser mon compte comme référence')
                    .setStyle(isSelfRef ? ButtonStyle.Secondary : ButtonStyle.Primary)
                    .setDisabled(!adminHasAccount || isSelfRef),
                new ButtonBuilder().setCustomId('cfg_reset').setLabel('Réinitialiser').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('cfg_done').setLabel('Terminer').setStyle(ButtonStyle.Success)
            );

            return { embeds: [embed], components: [announceRow, updateRow, buttonRow] };
        };

        const msg = await interaction.editReply(await render());
        const collector = msg.createMessageComponentCollector({ time: 300_000 });

        collector.on('collect', async (i) => {
            try {
                if (i.user.id !== interaction.user.id) {
                    await i.reply({ content: "Ce panneau ne t'appartient pas.", flags: MessageFlags.Ephemeral });
                    return;
                }
                collector.resetTimer();

                if (i.isButton() && i.customId === 'cfg_done') {
                    collector.stop('done');
                    await i.update({ content: '✅ Configuration enregistrée.', embeds: [], components: [] });
                    return;
                }

                // Certaines actions (amorçage des projets) appellent l'API MyGes et
                // peuvent dépasser les 3 s : on acquitte l'interaction d'abord.
                await i.deferUpdate();

                const data = loadData();
                const cfg = getGuildConfig(data, guildId);
                const by = `par ${i.user.tag}${ownerOverride ? ' [propriétaire]' : ''}`;

                if (i.isChannelSelectMenu()) {
                    if (i.customId === 'cfg_announce') {
                        cfg.announcementChannelId = i.values[0];
                        log('CONFIG', `${guild.name} : salon alertes = ${i.values[0]} (${by})`);
                    } else if (i.customId === 'cfg_update') {
                        cfg.updateChannelId = i.values[0];
                        log('CONFIG', `${guild.name} : salon MAJ = ${i.values[0]} (${by})`);
                    }
                } else if (i.isButton() && i.customId === 'cfg_ref_self') {
                    // Uniquement son propre compte : aucune donnée d'un tiers ne peut
                    // être exposée par un administrateur.
                    if (!data.users[i.user.id]) {
                        await i.followUp({ content: '❌ Connecte-toi d\'abord avec `/login`.', flags: MessageFlags.Ephemeral });
                        return;
                    }
                    cfg.referenceUserId = i.user.id;
                    log('CONFIG', `${guild.name} : compte de référence = ${i.user.id} (son propre compte)`);

                    // Premier paramétrage : on marque les projets DÉJÀ existants comme vus,
                    // sinon le prochain cycle annoncerait tout l'historique d'un coup.
                    if (cfg.knownProjectIds.length === 0) {
                        const token = await getSession(i.user.id);
                        if (token) {
                            try {
                                const projects = (await ProjectService.getProjects(token, getCurrentYear())) || [];
                                cfg.knownProjectIds = projects.map((p: any) => p.project_id).filter((id: any) => id != null);
                                log('CONFIG', `${guild.name} : ${cfg.knownProjectIds.length} projet(s) existant(s) marqué(s) comme déjà vus`);
                            } catch (e) {
                                logError('CONFIG', `${guild.name} : amorçage des projets impossible :`, e);
                            }
                        }
                    }
                } else if (i.isButton() && i.customId === 'cfg_reset') {
                    // On repart d'une config vierge pour ce serveur uniquement.
                    data.guilds[guildId] = { knownProjectIds: [] };
                    log('CONFIG', `${guild.name} : configuration réinitialisée (${by})`);
                }

                saveData(data);
                await interaction.editReply(await render());
            } catch (e) {
                logError('CONFIG', `${guild.name} : mise à jour du panneau impossible :`, e);
            }
        });

        collector.on('end', async (_collected, reason) => {
            if (reason === 'done') return; // panneau déjà refermé par « Terminer »
            // Panneau expiré : les contrôles ne répondraient plus, on les retire.
            await interaction.editReply({ components: [] }).catch(() => {});
        });
    },
};

export default command;
