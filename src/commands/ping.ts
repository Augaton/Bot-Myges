import { ChatInputCommandInteraction, EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { Command } from '../core/command';

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('ping')
        .setDescription("État du bot et de l'API MyGes"),

    execute: async (interaction: ChatInputCommandInteraction) => {
        await interaction.deferReply();
        const sent = await interaction.fetchReply();

        const roundtripLatency = sent.createdTimestamp - interaction.createdTimestamp;
        const wsLatency = interaction.client.ws.ping;

        // Test latence API MyGes
        let apiStatus = '🔴 Hors Ligne';
        let apiColor = 0xff0000;
        let apiTime = 0;
        let apiMsg = "L'API ne répond pas.";

        try {
            const start = Date.now();
            const response = await fetch('https://api.kordis.fr', { method: 'HEAD' });
            apiTime = Date.now() - start;

            if (response.status < 500) {
                // 200, 401 ou 403 -> le serveur est vivant
                apiStatus = '🟢 En Ligne';
                apiColor = 0x2ecc71;
                apiMsg = 'Opérationnel';
            } else {
                apiStatus = '🟠 Instable'; // Erreur 5xx
                apiColor = 0xe67e22;
            }
        } catch (e) {
            console.error('Erreur ping API:', e);
        }

        const embed = new EmbedBuilder()
            .setTitle('🏓 Pong !')
            .setColor(apiColor)
            .addFields(
                { name: '🤖 Bot Discord', value: `**Latence :** ${roundtripLatency}ms\n**WebSocket :** ${wsLatency}ms`, inline: true },
                { name: '🌐 API MyGes', value: `**État :** ${apiStatus}\n**Réponse :** ${apiTime}ms`, inline: true }
            )
            .setFooter({ text: apiMsg });

        await interaction.editReply({ embeds: [embed] });
    },
};

export default command;
