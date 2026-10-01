import { AttachmentBuilder, ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { Command } from '../core/command';
import { getTimetable } from '../core/mygesData';
import { addDays, getMonday } from '../utils/datePicker';
import { buildIcs } from '../utils/ics';
import { log, logError } from '../utils/logger';
import { apiErrorMessage, sessionFor } from '../utils/replies';

const DEFAULT_WEEKS = 4;
const MAX_WEEKS = 12;

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('export')
        .setDescription('Exporter ton emploi du temps (.ics) pour Google Agenda, Apple Calendrier…')
        .addIntegerOption((o) => o
            .setName('semaines')
            .setDescription(`Nombre de semaines à exporter à partir de cette semaine (${DEFAULT_WEEKS} par défaut)`)
            .setMinValue(1)
            .setMaxValue(MAX_WEEKS)),

    execute: async (interaction: ChatInputCommandInteraction) => {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const token = await sessionFor(interaction);
        if (!token) return;

        const weeks = interaction.options.getInteger('semaines') ?? DEFAULT_WEEKS;
        const monday = getMonday(new Date());
        const courses: any[] = [];
        try {
            // Semaine par semaine, comme /agenda : mêmes requêtes, même cache.
            for (let w = 0; w < weeks; w++) {
                const start = addDays(monday, w * 7);
                const end = addDays(start, 6);
                end.setHours(23, 59, 59);
                courses.push(...(await getTimetable(interaction.user.id, token, start, end)));
            }
        } catch (e) {
            logError('EXPORT', "Récupération de l'emploi du temps impossible :", e);
            return interaction.editReply(apiErrorMessage(e, "l'emploi du temps"));
        }

        const last = addDays(monday, weeks * 7 - 1);
        const period = `du ${monday.toLocaleDateString('fr-FR')} au ${last.toLocaleDateString('fr-FR')}`;
        if (!courses.length) return interaction.editReply(`🎉 Aucun cours ${period}.`);

        const file = new AttachmentBuilder(Buffer.from(buildIcs(courses), 'utf-8'), { name: 'emploi-du-temps.ics' });
        await interaction.editReply({
            content:
                `📥 **${courses.length} cours** ${period}.\n\n` +
                '**Google Agenda** (sur ordinateur) : Paramètres → Importer et exporter → Importer.\n' +
                '**iPhone / Mac** : ouvre le fichier, puis « Tout ajouter ».\n' +
                '**Android / Outlook** : ouvre le fichier avec ton application d\'agenda.\n\n' +
                '💡 Importe-le dans un agenda dédié (ex. « Cours ESGI ») : tu pourras le vider et réimporter une version à jour facilement.',
            files: [file],
        });
        log('EXPORT', `${interaction.user.tag} : ${courses.length} cours exportés (${weeks} semaine(s))`);
    },
};

export default command;
