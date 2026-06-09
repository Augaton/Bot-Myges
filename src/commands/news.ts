import { ChatInputCommandInteraction, EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { Command } from '../core/command';
import { SchoolService } from '../myges/services/school';
import { sessions } from '../core/store';

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('news')
        .setDescription("Dernières actualités de l'école"),

    execute: async (interaction: ChatInputCommandInteraction) => {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const token = sessions.get(interaction.user.id);
        if (!token) return interaction.editReply('❌ Connecte-toi.');

        try {
            const newsData: any = await SchoolService.getNews(token);
            // L'API renvoie souvent une pagination { content: [...] }
            const newsList = newsData.content || newsData;

            if (!newsList || newsList.length === 0) return interaction.editReply('Aucune actualité.');

            const embed = new EmbedBuilder().setTitle("📰 Actualités de l'école").setColor(0x00aeef);

            // On prend les 5 dernières
            newsList.slice(0, 5).forEach((n: any) => {
                const date = new Date(n.date).toLocaleDateString('fr-FR');
                let title = n.title || 'Sans titre';
                if (title.length > 250) title = title.substring(0, 250) + '...';
                embed.addFields({ name: `📅 ${date} - ${title}`, value: `> ${n.author || 'Administration'}` });
            });

            await interaction.editReply({ embeds: [embed] });
        } catch (e) {
            console.error(e);
            interaction.editReply('❌ Erreur news.');
        }
    },
};

export default command;
