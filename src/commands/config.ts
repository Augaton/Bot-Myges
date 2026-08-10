import {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType,
    ChatInputCommandInteraction, EmbedBuilder, MessageFlags, PermissionFlagsBits,
    SlashCommandBuilder,
} from 'discord.js';
import { Command } from '../core/command';
import { getGuildConfig, loadData, saveData, sessions } from '../core/store';
import { ProjectService } from '../myges/services/project';
import { getCurrentYear } from '../config';
import { log, logError } from '../utils/logger';

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('config')
        .setDescription('Configurer le bot pour ce serveur (réservé aux administrateurs)')
        // Masque la commande à tous ceux qui n'ont pas la permission Administrateur.
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    execute: async (interaction: ChatInputCommandInteraction) => {
        if (!interaction.inGuild() || !interaction.guild) {
            return interaction.reply({ content: "❌ Cette commande s'utilise uniquement sur un serveur.", flags: MessageFlags.Ephemeral });
        }
        // Double sécurité : on revérifie la permission côté exécution.
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: '⛔ Seuls les **administrateurs** du serveur peuvent configurer le bot.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const guild = interaction.guild;
        const guildId = guild.id;
        const adminId = interaction.user.id;

        // Construit le panneau (embed + contrôles) à partir de la config enregistrée.
        const render = async () => {
            const data = loadData();
            const cfg = getGuildConfig(data, guildId);

            // Le compte de référence ne peut être que celui de l'admin qui configure :
            // désigner le compte d'un tiers exposerait ses données sans son accord.
            const adminHasAccount = !!data.users[adminId];
            const isSelfRef = cfg.referenceUserId === adminId;

            const refStatus = cfg.referenceUserId
                ? sessions.has(cfg.referenceUserId)
                    ? `<@${cfg.referenceUserId}> ✅ connecté`
                    : `<@${cfg.referenceUserId}> ⚠️ non connecté (\`/login\` requis)`
                : '*non défini*';

            const ready = cfg.announcementChannelId && cfg.referenceUserId;

            const embed = new EmbedBuilder()
                .setTitle('⚙️ Configuration du bot')
                .setDescription(`Réglages propres à **${guild.name}**.\nChaque serveur a sa propre configuration.`)
                .setColor(ready ? 0x2ecc71 : 0xe67e22)
                .addFields(
                    { name: '📢 Salon des alertes projets', value: cfg.announcementChannelId ? `<#${cfg.announcementChannelId}>` : '*non défini*' },
                    { name: '🚀 Salon des mises à jour', value: cfg.updateChannelId ? `<#${cfg.updateChannelId}>` : '*non défini*' },
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

            embed.setFooter({ text: 'Confidentialité : seul ton propre compte peut servir de référence.' });

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
        const collector = msg.createMessageComponentCollector({ time: 300000 });

        collector.on('collect', async (i) => {
            if (i.user.id !== interaction.user.id) {
                return i.reply({ content: "Ce panneau ne t'appartient pas.", flags: MessageFlags.Ephemeral });
            }

            if (i.isButton() && i.customId === 'cfg_done') {
                collector.stop();
                await i.update({ content: '✅ Configuration enregistrée.', embeds: [], components: [] });
                return;
            }

            // Certaines actions (amorçage des projets) appellent l'API MyGes et
            // peuvent dépasser les 3 s : on acquitte l'interaction d'abord.
            await i.deferUpdate();

            const data = loadData();
            const cfg = getGuildConfig(data, guildId);

            if (i.isChannelSelectMenu()) {
                if (i.customId === 'cfg_announce') {
                    cfg.announcementChannelId = i.values[0];
                    log('CONFIG', `${guild.name} : salon alertes = ${i.values[0]} (par ${i.user.tag})`);
                } else if (i.customId === 'cfg_update') {
                    cfg.updateChannelId = i.values[0];
                    log('CONFIG', `${guild.name} : salon MAJ = ${i.values[0]} (par ${i.user.tag})`);
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
                    const token = sessions.get(i.user.id);
                    if (token) {
                        try {
                            const projects = await ProjectService.getProjects(token, getCurrentYear());
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
                log('CONFIG', `${guild.name} : configuration réinitialisée (par ${i.user.tag})`);
            }

            saveData(data);
            await interaction.editReply(await render());
        });
    },
};

export default command;
