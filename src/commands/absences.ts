import { ChatInputCommandInteraction, EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { Command } from '../core/command';
import { getAbsences } from '../core/mygesData';
import { logError } from '../utils/logger';
import { apiErrorMessage, sessionFor } from '../utils/replies';
import { shareRow } from '../utils/share';

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('absences')
        .setDescription('Les absences enregistrées sur MyGes'),

    execute: async (interaction: ChatInputCommandInteraction) => {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const token = await sessionFor(interaction);
        if (!token) return;

        let abs: any[];
        try {
            abs = await getAbsences(interaction.user.id, token);
        } catch (e) {
            logError('ABSENCES', 'Récupération des absences impossible :', e);
            return interaction.editReply(apiErrorMessage(e, 'les absences'));
        }
        if (!Array.isArray(abs)) abs = [];

        const embed = new EmbedBuilder().setTitle(`🚫 Absences (${abs.length})`).setColor(0xff0000);

        if (!abs.length) {
            embed.setDescription('Aucune absence !');
        } else {
            // L'ordre de l'API n'est pas garanti : sans ce tri, la limite de 10
            // pouvait masquer justement les absences les plus récentes.
            const recent = [...abs].sort((a, b) => (new Date(b?.date).getTime() || 0) - (new Date(a?.date).getTime() || 0));
            const unjustified = abs.filter((a) => !a?.justified).length;
            embed.setDescription(`**${unjustified}** non justifiée${unjustified > 1 ? 's' : ''} · les plus récentes d'abord`);
            for (const a of recent.slice(0, 10)) {
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
