import { ChatInputCommandInteraction, EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { Command } from '../core/command';
import { SchoolService } from '../myges/services/school';
import { sessions } from '../core/store';
import { snippet } from '../utils/format';
import { shareRow } from '../utils/share';

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
            const newsList: any[] = newsData.content || newsData;

            if (!newsList || newsList.length === 0) return interaction.editReply('Aucune actualité.');

            const embed = new EmbedBuilder()
                .setTitle("📰 Actualités de l'école")
                .setColor(0x00aeef)
                .setDescription(`Les **${Math.min(newsList.length, 5)}** dernières actualités`)
                .setFooter({ text: `${newsList.length} actualité(s) au total` });

            for (const n of newsList.slice(0, 5)) {
                const title = snippet(n.title || n.subject || 'Sans titre', 100);
                const body = snippet(n.message || n.content || n.body || n.description || '', 160);
                const author = n.author || n.populate || 'Administration';

                const parts: string[] = [];
                if (n.date) {
                    const ts = Math.floor(new Date(n.date).getTime() / 1000);
                    if (!isNaN(ts)) parts.push(`🗓️ <t:${ts}:D> · <t:${ts}:R>`);
                }
                parts.push(`✍️ *${author}*`);
                if (body) parts.push(`\n${body}`);

                embed.addFields({ name: `📌 ${title}`, value: parts.join('\n') });
            }

            await interaction.editReply({ embeds: [embed], components: [shareRow()] });
        } catch (e) {
            console.error(e);
            interaction.editReply('❌ Erreur news.');
        }
    },
};

export default command;
