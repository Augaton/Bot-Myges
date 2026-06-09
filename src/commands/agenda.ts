import {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction, ComponentType,
    EmbedBuilder, MessageFlags, ModalBuilder, SlashCommandBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { Command } from '../core/command';
import { TimetableService } from '../myges/services/timetable';
import { sessions } from '../core/store';
import { formatCampus, getCourseIcon } from '../utils/format';

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('agenda')
        .setDescription('Voir les cours du jour ou de la semaine avec navigation'),

    execute: async (interaction: ChatInputCommandInteraction) => {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const formatTime = (d: any) => new Date(d).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
        const formatDate = (d: Date) => d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Paris' });
        const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

        const getMonday = (d: Date) => {
            const date = new Date(d);
            const day = date.getDay();
            const diff = date.getDate() - day + (day === 0 ? -6 : 1);
            date.setDate(diff);
            return date;
        };

        const generateAgenda = async (mode: 'day' | 'week', refDate: Date): Promise<EmbedBuilder> => {
            const currentToken = sessions.get(interaction.user.id);
            if (!currentToken) return new EmbedBuilder().setTitle('Erreur').setDescription('Session expirée. Fais /login').setColor(0xff0000);

            let start = new Date(refDate);
            let end = new Date(refDate);
            let title = '';

            if (mode === 'day') {
                start.setHours(0, 0, 0, 0);
                end.setHours(23, 59, 59);
                title = `📅 Agenda du ${capitalize(formatDate(start))}`;
            } else {
                start = getMonday(refDate);
                start.setHours(0, 0, 0, 0);
                end = new Date(start);
                end.setDate(end.getDate() + 6);
                end.setHours(23, 59, 59);
                title = `🗓️ Semaine du ${start.toLocaleDateString('fr-FR')} au ${end.toLocaleDateString('fr-FR')}`;
            }

            try {
                const cours = await TimetableService.getTimetable(currentToken, start, end);
                if (!cours) throw new Error('API renvoie vide');

                cours.sort((a: any, b: any) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime());

                const embed = new EmbedBuilder().setTitle(title).setColor(mode === 'day' ? 0x3498db : 0x2b2d31);

                if (cours.length === 0) {
                    embed.setDescription('🏖️ **Aucun cours sur cette période !**');
                } else if (mode === 'day') {
                    let content = '';
                    cours.forEach((c: any) => {
                        const sStr = formatTime(c.start_date);
                        const eStr = formatTime(c.end_date);
                        const name = c.name.replace(/^(T\d+\s-\s)/i, '').trim();
                        let loc = 'S. Inconnue';
                        let icon = '🏫';
                        let campusStr = '';

                        if (c.modality === 'Distanciel') {
                            loc = 'Distanciel';
                            icon = '🏠';
                        } else if (c.rooms && c.rooms.length > 0) {
                            loc = c.rooms.map((r: any) => r.name).join(', ');
                            const rawCampus = c.rooms[0].campus;
                            if (rawCampus) campusStr = ` - ${formatCampus(rawCampus)}`;
                        }
                        const prof = c.teacher ? ` • *${c.teacher.replace('M. ', '').replace('Mme ', '')}*` : '';
                        content += `\`${sStr} - ${eStr}\` ${icon} **${name}**\n└ 📍 ${loc}**${campusStr}**${prof}\n\n`;
                    });
                    embed.setDescription(content);
                } else {
                    const days: { [key: string]: any[] } = {};
                    cours.forEach((c: any) => {
                        const dKey = capitalize(formatDate(new Date(c.start_date)));
                        if (!days[dKey]) days[dKey] = [];
                        days[dKey].push(c);
                    });

                    for (const [dayName, dayCourses] of Object.entries(days)) {
                        const content = (dayCourses as any[]).map((c) => {
                            const sStr = formatTime(c.start_date);
                            const eStr = formatTime(c.end_date);
                            let name = c.name.replace(/^(T\d+\s-\s)/i, '').trim();
                            if (name.length > 30) name = name.substring(0, 28) + '…';
                            const emoji = getCourseIcon(c.name, c.modality);
                            let loc = 'S. Inconnue';
                            let campusStr = '';
                            if (c.modality === 'Distanciel') {
                                loc = 'Distanciel';
                            } else if (c.rooms && c.rooms.length > 0) {
                                loc = c.rooms.map((r: any) => r.name).join(', ');
                                if (c.rooms[0].campus) campusStr = ` (${formatCampus(c.rooms[0].campus)})`;
                            }
                            return `**${name}** ${emoji} • \`${sStr} - ${eStr}\`\n└ 📍 ${loc}${campusStr}`;
                        }).join('\n\n');
                        embed.addFields({ name: `📅 ${dayName}`, value: content });
                    }
                }
                if (cours.length > 0) embed.setFooter({ text: `${cours.length} cours trouvés` });
                return embed;
            } catch (e) {
                console.error('[Agenda Error]', e);
                return new EmbedBuilder().setTitle('Erreur').setDescription("Impossible de récupérer l'agenda.").setColor(0xff0000);
            }
        };

        let currentMode: 'day' | 'week' = 'week';
        let currentDate = new Date();

        const getRow = (m: 'day' | 'week') => {
            const isToday = new Date().toDateString() === currentDate.toDateString();
            const labelSwitch = m === 'day' ? '📅 Voir Semaine' : '📆 Voir Jour';
            return new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId('prev').setLabel('⬅️').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('today').setLabel("Aujourd'hui").setStyle(ButtonStyle.Primary).setDisabled(isToday),
                new ButtonBuilder().setCustomId('next').setLabel('➡️').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('switch').setLabel(labelSwitch).setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('jump').setLabel('🔍 Aller à...').setStyle(ButtonStyle.Secondary)
            );
        };

        const msg = await interaction.editReply({
            embeds: [await generateAgenda(currentMode, currentDate)],
            components: [getRow(currentMode)],
        });

        const col = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 300000 });

        col.on('collect', async (i) => {
            if (i.user.id !== interaction.user.id) return i.reply({ content: 'Pas touche !', flags: MessageFlags.Ephemeral });

            if (i.customId === 'jump') {
                const modal = new ModalBuilder().setCustomId('jump_modal').setTitle('Aller à une date');
                const dateInput = new TextInputBuilder().setCustomId('date_input').setLabel('Date (JJ/MM)').setStyle(TextInputStyle.Short).setMaxLength(5).setRequired(true);
                modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(dateInput));
                await i.showModal(modal);
                try {
                    const submit = await i.awaitModalSubmit({ time: 60000, filter: (s) => s.user.id === i.user.id });
                    const val = submit.fields.getTextInputValue('date_input');
                    const [day, month] = val.split('/').map(Number);
                    if (!day || !month || day > 31 || month > 12) {
                        await submit.reply({ content: '❌ Date invalide.', flags: MessageFlags.Ephemeral });
                        return;
                    }
                    const newDate = new Date();
                    newDate.setMonth(month - 1);
                    newDate.setDate(day);
                    currentDate = newDate;
                    await submit.deferUpdate();
                    await interaction.editReply({ embeds: [await generateAgenda(currentMode, currentDate)], components: [getRow(currentMode)] });
                } catch (e) {
                    // Le plus souvent : l'utilisateur n'a pas validé le modal à temps (timeout). On ignore en loguant.
                    console.error('[Agenda Jump] modal non soumis ou erreur :', e);
                }
                return;
            }

            await i.deferUpdate();
            const newDate = new Date(currentDate);

            if (i.customId === 'prev') {
                newDate.setDate(newDate.getDate() - (currentMode === 'day' ? 1 : 7));
            } else if (i.customId === 'next') {
                newDate.setDate(newDate.getDate() + (currentMode === 'day' ? 1 : 7));
            } else if (i.customId === 'today') {
                newDate.setTime(new Date().getTime());
            } else if (i.customId === 'switch') {
                currentMode = currentMode === 'day' ? 'week' : 'day';
            }

            currentDate = newDate;
            await interaction.editReply({
                embeds: [await generateAgenda(currentMode, currentDate)],
                components: [getRow(currentMode)],
            });
        });
    },
};

export default command;
