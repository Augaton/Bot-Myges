import {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction, ComponentType, EmbedBuilder,
    MessageFlags, SlashCommandBuilder,
} from 'discord.js';
import { Command } from '../core/command';
import { getUserAlerts, hasAccount, loadData, saveData } from '../core/store';
import { sendDM } from '../utils/dm';
import { log, logError } from '../utils/logger';

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('alertes')
        .setDescription('Gérer tes alertes en MP : notes, rendus, changements d\'agenda, programme du matin'),

    execute: async (interaction: ChatInputCommandInteraction) => {
        const userId = interaction.user.id;
        if (!hasAccount(userId)) {
            return interaction.reply({ content: "❌ Connecte-toi d'abord avec `/login`.", flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const view = () => {
            const alerts = getUserAlerts(loadData(), userId);
            const embed = new EmbedBuilder()
                .setTitle('🔔 Tes alertes en MP')
                .setDescription('Je t\'écris en message privé, à toi seul.')
                .setColor(0x5865f2)
                .addFields(
                    {
                        name: '📝 Nouvelles notes',
                        value: alerts.grades
                            ? '✅ Activées : un MP dès qu\'une note apparaît sur MyGes (vérifié toutes les heures).'
                            : '❌ Désactivées',
                    },
                    {
                        name: '⏰ Rappels de rendus',
                        value: alerts.reminders
                            ? '✅ Activés : un MP la veille (24 h avant) et 2 h avant chaque échéance de projet.'
                            : '❌ Désactivés',
                    },
                    {
                        name: '🗓️ Changements d\'agenda',
                        value: alerts.agenda
                            ? '✅ Activés : un MP si un cours de la semaine à venir est annulé, déplacé, ajouté ou change de salle (vérifié toutes les heures).'
                            : '❌ Désactivés',
                    },
                    {
                        name: '☀️ Programme du matin',
                        value: alerts.digest
                            ? '✅ Activé : chaque matin vers 7 h, un MP avec tes cours du jour.'
                            : '❌ Désactivé',
                    },
                )
                .setFooter({ text: 'Rien reçu ? Vérifie que tu acceptes les MP des membres du serveur.' });

            const toggle = (id: string, on: boolean, icon: string, what: string) => new ButtonBuilder()
                .setCustomId(id)
                .setLabel(`${icon} ${on ? 'Désactiver' : 'Activer'} ${what}`)
                .setStyle(on ? ButtonStyle.Secondary : ButtonStyle.Success);
            const toggles = new ActionRowBuilder<ButtonBuilder>().addComponents(
                toggle('alert_grades', alerts.grades, '📝', 'les notes'),
                toggle('alert_reminders', alerts.reminders, '⏰', 'les rappels'),
                toggle('alert_agenda', alerts.agenda, '🗓️', 'l\'agenda'),
                toggle('alert_digest', alerts.digest, '☀️', 'le matin'),
            );
            const test = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId('alert_test').setLabel('📨 Tester les MP').setStyle(ButtonStyle.Primary),
            );
            return { embeds: [embed], components: [toggles, test] };
        };

        const msg = await interaction.editReply(view());
        const collector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 300_000 });

        collector.on('collect', async (i) => {
            try {
                if (i.user.id !== userId) {
                    await i.reply({ content: "Ce panneau ne t'appartient pas.", flags: MessageFlags.Ephemeral });
                    return;
                }
                collector.resetTimer();

                if (i.customId === 'alert_test') {
                    await i.deferUpdate();
                    const ok = await sendDM(i.client, userId, { content: '✅ Test réussi : tu recevras bien tes alertes ici.' });
                    await i.followUp({
                        content: ok
                            ? '📨 MP envoyé, regarde tes messages privés !'
                            : "❌ Impossible de t'écrire en MP. Active « Messages privés » dans les paramètres de confidentialité du serveur, puis réessaie.",
                        flags: MessageFlags.Ephemeral,
                    });
                    return;
                }

                const data = loadData();
                if (!data.users[userId]) {
                    await i.update({ content: "❌ Tu n'es plus connecté.", embeds: [], components: [] });
                    return;
                }
                const alerts = getUserAlerts(data, userId);
                if (i.customId === 'alert_grades') {
                    alerts.grades = !alerts.grades;
                    // Notes oubliées à la désactivation : à la réactivation, celles
                    // parues entre-temps sont mémorisées sans t'inonder de MP.
                    if (!alerts.grades) {
                        delete alerts.knownGrades;
                        delete alerts.gradesYear;
                    }
                } else if (i.customId === 'alert_reminders') {
                    alerts.reminders = !alerts.reminders;
                } else if (i.customId === 'alert_agenda') {
                    alerts.agenda = !alerts.agenda;
                    // Même logique que les notes : à la réactivation, l'agenda est
                    // relu sans signaler ce qui a changé entre-temps.
                    if (!alerts.agenda) delete alerts.agendaSnapshot;
                } else if (i.customId === 'alert_digest') {
                    alerts.digest = !alerts.digest;
                }
                saveData(data);
                const state = (on: boolean) => (on ? 'on' : 'off');
                log('ALERTES', `${userId} : notes ${state(alerts.grades)}, rappels ${state(alerts.reminders)}, agenda ${state(alerts.agenda)}, matin ${state(alerts.digest)}`);
                await i.update(view());
            } catch (e) {
                logError('ALERTES', 'Mise à jour du panneau impossible :', e);
            }
        });

        collector.on('end', async () => {
            await interaction.editReply({ components: [] }).catch(() => {});
        });
    },
};

export default command;
