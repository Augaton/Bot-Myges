import { Client, EmbedBuilder, TextChannel } from 'discord.js';
import { ProjectService } from '../myges/services/project';
import { ANNOUNCEMENT_CHANNEL_ID, getCurrentYear } from '../config';
import { loadData, saveData, sessions } from '../core/store';
import { getNextStep } from '../utils/format';

// --- ALERTE PROJETS : prévient le channel d'annonces des nouveaux projets ---
export async function checkNewProjects(client: Client) {
    console.log('🔄 Vérification projets...');
    const data = loadData();
    let hasNewData = false;
    const channel = (await client.channels.fetch(ANNOUNCEMENT_CHANNEL_ID).catch(() => null)) as TextChannel;

    if (!channel) return;

    for (const [userId, token] of sessions) {
        try {
            const projects = await ProjectService.getProjects(token, getCurrentYear());
            for (const p of projects) {
                if (!data.knownProjectIds.includes(p.project_id)) {
                    const nextStep = getNextStep(p);
                    const dateStr = nextStep ? new Date(nextStep.date).toLocaleDateString('fr-FR') : 'Non définie';
                    const typeStep = nextStep ? nextStep.type : 'Lancement';

                    const embed = new EmbedBuilder()
                        .setTitle('🚨 NOUVEAU PROJET !')
                        .setDescription(`Nouveau projet en **${p.course_name}**`)
                        .setColor(0xff0000)
                        .addFields(
                            { name: 'Nom', value: p.name, inline: true },
                            { name: `📅 ${typeStep}`, value: dateStr, inline: true },
                            { name: 'Objectif', value: p.project_teaching_goals ? p.project_teaching_goals.substring(0, 500) : 'Voir MyGes' }
                        )
                        .setFooter({ text: 'Alerte MyGes' })
                        .setTimestamp();

                    await channel.send({ embeds: [embed] });
                    data.knownProjectIds.push(p.project_id);
                    hasNewData = true;
                }
            }
        } catch (e) {
            console.error(`❌ Erreur vérification projets pour ${userId} :`, e);
        }
        await new Promise((r) => setTimeout(r, 5000));
    }
    if (hasNewData) saveData(data);
}
