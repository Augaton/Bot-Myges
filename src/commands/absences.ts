import { ChatInputCommandInteraction, EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { Command } from '../core/command';
import { ProfileService } from '../myges/services/profile';
import { getCurrentYear } from '../config';
import { sessions } from '../core/store';
import { logError } from '../utils/logger';
import { shareRow } from '../utils/share';

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('absences')
        .setDescription('Les absences enregistrées sur MyGes'),

    execute: async (interaction: ChatInputCommandInteraction) => {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const token = sessions.get(interaction.user.id);
        if (!token) return interaction.editReply("❌ Connecte-toi d'abord. (/login)");

        let abs: any[];
        try {
            // L'API renvoie parfois null au lieu d'un tableau vide.
            abs = (await ProfileService.getAbsences(token, getCurrentYear())) || [];
        } catch (e) {
            logError('ABSENCES', 'Récupération des absences impossible :', e);
            return interaction.editReply('❌ Erreur lors de la récupération des absences.');
        }
        if (!Array.isArray(abs)) abs = [];

        const embed = new EmbedBuilder().setTitle(`🚫 Absences (${abs.length})`).setColor(0xff0000);

        if (!abs.length) {
            embed.setDescription('Aucune absence !');
        } else {
            for (const a of abs.slice(0, 10)) {
                // Discord refuse un champ dont le nom ou la valeur est vide.
                const name = String(a?.course_name || 'Matière inconnue').slice(0, 256);
                const when = a?.date ? new Date(a.date) : null;
                const dateStr = when && !isNaN(when.getTime())
                    ? when.toLocaleDateString('fr-FR')
                    : 'Date inconnue';
                embed.addFields({ name, value: `📅 ${dateStr} - ${a?.justified ? '✅' : '❌ INJUSTIFIÉE'}` });
            }
            if (abs.length > 10) embed.setFooter({ text: `+ ${abs.length - 10} autre(s) absence(s)` });
        }

        await interaction.editReply({ embeds: [embed], components: [shareRow()] });
    },
};

export default command;
