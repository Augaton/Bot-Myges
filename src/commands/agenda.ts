import {
    ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction,
    ComponentType, EmbedBuilder, MessageFlags, ModalBuilder, SlashCommandBuilder, TextInputBuilder,
    TextInputStyle,
} from 'discord.js';
import { Command } from '../core/command';
import { TimetableService } from '../myges/services/timetable';
import { sessions } from '../core/store';
import { renderDayImage, renderWeekImage } from '../utils/agendaImage';

interface AgendaView {
    embeds: EmbedBuilder[];
    files: AttachmentBuilder[];
}

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('agenda')
        .setDescription('Voir les cours du jour ou de la semaine avec navigation'),

    execute: async (interaction: ChatInputCommandInteraction) => {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const getMonday = (d: Date) => {
            const date = new Date(d);
            const day = date.getDay();
            const diff = date.getDate() - day + (day === 0 ? -6 : 1);
            date.setDate(diff);
            date.setHours(0, 0, 0, 0);
            return date;
        };

        const errorView = (msg: string): AgendaView => ({
            embeds: [new EmbedBuilder().setTitle('Erreur').setDescription(msg).setColor(0xff0000)],
            files: [],
        });

        // Génère la vue graphique (image PNG) pour un mode et une date de référence.
        const generateAgenda = async (mode: 'day' | 'week', refDate: Date): Promise<AgendaView> => {
            const currentToken = sessions.get(interaction.user.id);
            if (!currentToken) return errorView('Session expirée. Fais /login');

            let start: Date;
            let end: Date;
            if (mode === 'day') {
                start = new Date(refDate);
                start.setHours(0, 0, 0, 0);
                end = new Date(start);
                end.setHours(23, 59, 59);
            } else {
                start = getMonday(refDate);
                end = new Date(start);
                end.setDate(end.getDate() + 6);
                end.setHours(23, 59, 59);
            }

            try {
                const cours = (await TimetableService.getTimetable(currentToken, start, end)) || [];
                const buffer = mode === 'day' ? renderDayImage(cours, refDate) : renderWeekImage(cours, start);
                const file = new AttachmentBuilder(buffer, { name: 'agenda.png' });
                const embed = new EmbedBuilder()
                    .setColor(mode === 'day' ? 0x3498db : 0x5865f2)
                    .setImage('attachment://agenda.png');
                return { embeds: [embed], files: [file] };
            } catch (e) {
                console.error('[Agenda Error]', e);
                return errorView("Impossible de récupérer l'agenda.");
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
            ...(await generateAgenda(currentMode, currentDate)),
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
                    await interaction.editReply({ ...(await generateAgenda(currentMode, currentDate)), components: [getRow(currentMode)] });
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
                ...(await generateAgenda(currentMode, currentDate)),
                components: [getRow(currentMode)],
            });
        });
    },
};

export default command;
