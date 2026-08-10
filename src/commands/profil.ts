import { ChatInputCommandInteraction, EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { Command } from '../core/command';
import { ProfileService } from '../myges/services/profile';
import { sessions } from '../core/store';
import { shareRow } from '../utils/share';

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('profil')
        .setDescription('Affiche les informations de ton profil MyGes'),

    execute: async (interaction: ChatInputCommandInteraction) => {
        const token = sessions.get(interaction.user.id);
        if (!token) return interaction.reply({ content: "❌ Connecte-toi d'abord. (/login)", flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const p = await ProfileService.getProfile(token);
            const embed = new EmbedBuilder()
                .setTitle(`👤 ${p.firstname} ${p.name}`)
                .setColor(0x5865f2)
                .setThumbnail(p._links?.photo?.href || null)
                .addFields(
                    { name: 'Email', value: p.email },
                    { name: 'Classe', value: p.classes?.map((c: any) => c.name).join(', ') || '?' }
                );
            await interaction.editReply({ embeds: [embed], components: [shareRow()] });
        } catch (e) {
            console.error(e);
            await interaction.editReply('❌ Erreur.');
        }
    },
};

export default command;
