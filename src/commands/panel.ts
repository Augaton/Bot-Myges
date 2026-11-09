import { ChatInputCommandInteraction, EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { Command } from '../core/command';
import { panelPublicUrl } from '../config';

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('panel')
        .setDescription('Obtenir le lien du panel étudiant'),

    execute: async (interaction: ChatInputCommandInteraction) => {
        const url = panelPublicUrl();
        if (!url) {
            return interaction.reply({ content: '🌐 Le panel étudiant n\'est pas disponible pour le moment.', flags: MessageFlags.Ephemeral });
        }
        const embed = new EmbedBuilder()
            .setTitle('🌐 Panel étudiant')
            .setDescription(
                `**[Ouvrir le panel](${url})**\n${url}\n\n` +
                'Connecte-toi avec ton identifiant MyGES : ton mot de passe sert une seule fois à vérifier ton compte et n\'est jamais enregistré.'
            )
            .setColor(0x5865f2)
            .setFooter({ text: 'Service non officiel, sans lien avec MyGES ni le Réseau GES.' });
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
};

export default command;
