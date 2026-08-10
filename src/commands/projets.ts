import { ChatInputCommandInteraction, EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { Command } from '../core/command';
import { ProjectService } from '../myges/services/project';
import { getCurrentYear } from '../config';
import { sessions } from '../core/store';
import { getNextStep, snippet } from '../utils/format';
import { logError } from '../utils/logger';
import { shareRow } from '../utils/share';

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('projets')
        .setDescription('Liste de tes projets en cours avec les prochaines étapes'),

    execute: async (interaction: ChatInputCommandInteraction) => {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const token = sessions.get(interaction.user.id);
        if (!token) return interaction.editReply('❌ Connecte-toi.');

        try {
            const projects = (await ProjectService.getProjects(token, getCurrentYear())) || [];
            const now = Date.now();

            // On ne garde que les projets ayant une étape future
            const active: any[] = [];
            for (const p of projects) {
                const nextStep = getNextStep(p);
                if (nextStep) {
                    p._nextStep = nextStep;
                    active.push(p);
                }
            }

            if (active.length === 0) return interaction.editReply('🎉 Aucun projet en cours !');

            // Tri : du plus urgent au moins urgent
            active.sort((a, b) => a._nextStep.date - b._nextStep.date);

            // Couleur de l'embed selon l'urgence du projet le plus proche
            const firstDays = Math.ceil((active[0]._nextStep.date - now) / 86400000);
            const headColor = firstDays <= 3 ? 0xe74c3c : firstDays <= 7 ? 0xe67e22 : 0x2ecc71;

            const embed = new EmbedBuilder()
                .setTitle('📂 Mes projets')
                .setDescription(`**${active.length}** projet${active.length > 1 ? 's' : ''} en cours · triés par échéance`)
                .setColor(headColor)
                .setFooter({ text: 'Les délais se mettent à jour automatiquement' });

            for (const p of active.slice(0, 10)) {
                const step = p._nextStep;
                const ts = Math.floor(step.date / 1000);
                const diffDays = Math.ceil((step.date - now) / 86400000);
                const urgent = diffDays <= 3 ? '🔴' : diffDays <= 7 ? '🟠' : '🟢';

                const lines = [
                    `📚 **${p.course_name}**`,
                    `🎯 ${step.type} · 🗓️ <t:${ts}:D> (**<t:${ts}:R>**)`,
                ];
                const desc = snippet(p.project_teaching_goals);
                if (desc) lines.push(`> ${desc}`);

                // Discord plafonne le nom d'un champ à 256 caractères.
                embed.addFields({ name: `${urgent} ${p.name || 'Projet'}`.slice(0, 256), value: lines.join('\n') });
            }

            await interaction.editReply({ embeds: [embed], components: [shareRow()] });
        } catch (e) {
            logError('PROJETS', 'Récupération des projets impossible :', e);
            await interaction.editReply('❌ Erreur lors de la récupération des projets.');
        }
    },
};

export default command;
