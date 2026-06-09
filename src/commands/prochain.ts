import { ChatInputCommandInteraction, EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { Command } from '../core/command';
import { TimetableService } from '../myges/services/timetable';
import { sessions } from '../core/store';
import { formatCampus, formatToFrenchTime } from '../utils/format';

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('prochain')
        .setDescription('Affiche le prochain cours à venir'),

    execute: async (interaction: ChatInputCommandInteraction) => {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const token = sessions.get(interaction.user.id);
        if (!token) return interaction.editReply("❌ Connecte-toi d'abord. (/login)");

        try {
            const start = new Date();
            const end = new Date();
            end.setDate(end.getDate() + 7);
            const cours = await TimetableService.getTimetable(token, start, end);
            const now = Date.now();
            const futurs = cours.filter((c: any) => new Date(c.start_date).getTime() > now);

            if (futurs.length === 0) {
                return interaction.editReply('🎉 Aucun cours prévu dans les 7 prochains jours !');
            }
            futurs.sort((a: any, b: any) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime());
            const c = futurs[0];
            const dateDebut = new Date(c.start_date);
            const dateFin = new Date(c.end_date);
            const nomCours = c.name.replace(/^T\d+\s-\s/i, '');

            let salle = 'Non défini';
            let icon = '🏫';

            if (c.modality === 'Distanciel' || (c.rooms && c.rooms.some((r: any) => r.name.toLowerCase().includes('distanciel')))) {
                salle = 'Distanciel';
                icon = '🏠';
            } else if (c.rooms && c.rooms.length > 0) {
                salle = c.rooms.map((r: any) => r.name).join(', ');
                const rawCampus = c.rooms[0].campus;
                if (rawCampus) salle += ` (${formatCampus(rawCampus)})`;
            }

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

            await interaction.editReply({ embeds: [embed] });
        } catch (e) {
            console.error(e);
            interaction.editReply('❌ Erreur lors de la récupération.');
        }
    },
};

export default command;
