import { ChatInputCommandInteraction, EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { Command } from '../core/command';
import { ProfileService } from '../myges/services/profile';
import { sessions } from '../core/store';
import { fullName } from '../utils/format';
import { logError } from '../utils/logger';
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
            // `p.name` porte le nom de famille côté MyGes : on réutilise le
            // helper commun, qui garantit une valeur non vide (Discord refuse
            // un champ d'embed vide et rejette alors toute la réponse).
            const embed = new EmbedBuilder()
                .setTitle(`👤 ${fullName({ firstname: p?.firstname, lastname: p?.name })}`)
                .setColor(0x5865f2)
                .setThumbnail(p?._links?.photo?.href || null)
                .addFields(
                    { name: 'Email', value: p?.email || 'Non renseigné' },
                    { name: 'Classe', value: p?.classes?.map((c: any) => c.name).filter(Boolean).join(', ') || '?' }
                );
            await interaction.editReply({ embeds: [embed], components: [shareRow()] });
        } catch (e) {
            logError('PROFIL', 'Récupération du profil impossible :', e);
            await interaction.editReply('❌ Erreur lors de la récupération du profil.');
        }
    },
};

export default command;
