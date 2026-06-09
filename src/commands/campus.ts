import { ChatInputCommandInteraction, EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { Command } from '../core/command';
import { sessions } from '../core/store';

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('campus')
        .setDescription("Affiche les différents campus de l'ESGI (Pour le moment que les codes d'accés"),

    execute: async (interaction: ChatInputCommandInteraction) => {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const token = sessions.get(interaction.user.id);
        if (!token) return interaction.editReply("❌ Connecte-toi d'abord. (/login)");

        const embed = new EmbedBuilder()
            .setTitle("🏫 Campus & Codes d'accès")
            .setDescription("Retrouvez ci-dessous les adresses et les codes d'entrée des différents bâtiments du réseau.")
            .setColor(0x3498db)
            .setThumbnail(interaction.client.user?.displayAvatarURL() || null)
            .addFields(
                { name: '🏢 Nation 1 & 2', value: '📍 *242 Rue du Faubourg Saint-Antoine, 75012 Paris*\n🔑 Code : **38950**' },
                { name: '🏢 Erard', value: '📍 *21 Rue Erard, 75012 Paris*\n🔑 Code : **2125**' },
                { name: '🎨 Voltaire 1 (Studio Crea)', value: '📍 *1 Rue Bouvier, 75011 Paris*\n🔑 Code : **1175**' },
                { name: '📷 Voltaire 2 (Efet)', value: '📍 *1 Rue Bouvier, 75011 Paris*\n🔑 Code : **1175**' },
                { name: '🏛️ Rauch', value: '📍 *15 Rue Rames, 75012 Paris*\n🔑 Code : **2804**' }
            )
            .setFooter({ text: 'Gardez ces codes pour vous ! 🤫' })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    },
};

export default command;
