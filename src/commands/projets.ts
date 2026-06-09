import { ChatInputCommandInteraction, EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { Command } from '../core/command';
import { ProjectService } from '../myges/services/project';
import { getCurrentYear } from '../config';
import { sessions } from '../core/store';
import { getNextStep } from '../utils/format';

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('projets')
        .setDescription('Liste de tes projets en cours avec les prochaines étapes'),

    execute: async (interaction: ChatInputCommandInteraction) => {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const token = sessions.get(interaction.user.id);
        if (!token) return interaction.editReply('❌ Connecte-toi.');

        try {
            const projects = await ProjectService.getProjects(token, getCurrentYear());
            const now = Date.now();

            // On ne garde que les projets ayant une étape future
            const activeProjects: any[] = [];
            projects.forEach((p: any) => {
                const nextStep = getNextStep(p);
                if (nextStep) {
                    p._nextStep = nextStep; // injecté pour l'affichage / le tri
                    activeProjects.push(p);
                }
            });

            if (activeProjects.length === 0) return interaction.editReply('🎉 Aucun projet en cours !');

            // Tri : du plus urgent au moins urgent
            activeProjects.sort((a, b) => a._nextStep.date - b._nextStep.date);

            const embed = new EmbedBuilder().setTitle('📂 Projets et Deadlines').setColor(0xffa500);

            activeProjects.slice(0, 10).forEach((p: any) => {
                const step = p._nextStep;
                const dateRendu = new Date(step.date).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
                const desc = p.project_teaching_goals ? p.project_teaching_goals.substring(0, 80) + '...' : 'Pas de description';

                const diffDays = Math.ceil((step.date - now) / (1000 * 60 * 60 * 24));
                const alertEmoji = diffDays <= 3 ? '🔥' : diffDays <= 7 ? '⚠️' : '⏳';

                embed.addFields({
                    name: `${alertEmoji} ${p.name}`,
                    value: `📚 **${p.course_name}**\n🎯 **Prochaine étape : ${step.type}**\n📅 Pour le ${dateRendu} (dans ${diffDays}j)\n> *${desc}*`,
                });
            });

            await interaction.editReply({ embeds: [embed] });
        } catch (e) {
            console.error(e);
            await interaction.editReply('❌ Erreur projets.');
        }
    },
};

export default command;
