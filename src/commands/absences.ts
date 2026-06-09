import { ChatInputCommandInteraction, EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { Command } from '../core/command';
import { ProfileService } from '../myges/services/profile';
import { getCurrentYear } from '../config';
import { sessions } from '../core/store';

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('absences')
        .setDescription('Les absences enregistrées sur MyGes'),

    execute: async (interaction: ChatInputCommandInteraction) => {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const token = sessions.get(interaction.user.id);
        if (!token) return interaction.editReply('❌ Connecte-toi.');
        const abs = await ProfileService.getAbsences(token, getCurrentYear());
        const embed = new EmbedBuilder().setTitle(`🚫 Absences (${abs.length})`).setColor(0xff0000);
        if (!abs.length) embed.setDescription('Aucune absence !');
        else abs.slice(0, 10).forEach((a: any) => embed.addFields({ name: a.course_name, value: `📅 ${new Date(a.date).toLocaleDateString()} - ${a.justified ? '✅' : '❌ INJUSTIFIÉE'}` }));
        await interaction.editReply({ embeds: [embed] });
    },
};

export default command;
