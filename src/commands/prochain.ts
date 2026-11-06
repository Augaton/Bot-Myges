import { ChatInputCommandInteraction, EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { Command } from '../core/command';
import { getTimetable } from '../core/mygesData';
import { addDays, startOfDay } from '../utils/datePicker';
import { courseName, coursePlace, formatToFrenchTime } from '../utils/format';
import { logError } from '../utils/logger';
import { apiErrorMessage, sessionFor } from '../utils/replies';
import { shareRow } from '../utils/share';

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('prochain')
        .setDescription('Affiche le prochain cours à venir'),

    execute: async (interaction: ChatInputCommandInteraction) => {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const token = await sessionFor(interaction);
        if (!token) return;

        try {
            // Bornes calées sur minuit : la lecture est stable toute la journée, donc
            // en cache, et c'est la même que celle des alertes d'agenda.
            const start = startOfDay(new Date());
            const cours = await getTimetable(interaction.user.id, token, start, addDays(start, 8));
            const now = Date.now();
            const futurs = cours.filter((c: any) => new Date(c.start_date).getTime() > now);

            if (futurs.length === 0) {
                return interaction.editReply('🎉 Aucun cours prévu dans les 7 prochains jours !');
            }
            futurs.sort((a: any, b: any) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime());
            const c = futurs[0];
            const dateDebut = new Date(c.start_date);
            const dateFin = new Date(c.end_date);
            const nomCours = courseName(c);

            const place = coursePlace(c);
            const salle = place || 'Non défini';
            const icon = place === 'Distanciel' ? '🏠' : '🏫';

            const timestamp = Math.floor(dateDebut.getTime() / 1000);

            const embed = new EmbedBuilder()
                .setTitle('🏃 Prochain Cours')
                .setColor(0x2ecc71)
                .setDescription(`**${nomCours}**`)
                .addFields(
                    { name: '📍 Salle', value: `${icon} **${salle}**`, inline: true },
                    { name: '⏰ Horaire', value: `<t:${timestamp}:t>`, inline: true },
                    { name: '⏳ Début', value: `<t:${timestamp}:R>`, inline: true }
                )
                .setFooter({ text: `Fin du cours à ${formatToFrenchTime(dateFin)}` });

            await interaction.editReply({ embeds: [embed], components: [shareRow()] });
        } catch (e) {
            logError('PROCHAIN', 'Récupération du prochain cours impossible :', e);
            await interaction.editReply(apiErrorMessage(e, 'le prochain cours'));
        }
    },
};

export default command;
