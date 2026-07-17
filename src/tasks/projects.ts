import { Client, EmbedBuilder, TextChannel } from 'discord.js';
import { ProjectService } from '../myges/services/project';
import { getCurrentYear } from '../config';
import { getGuildConfig, loadData, saveData, sessions } from '../core/store';
import { getNextStep } from '../utils/format';
import { log, logError } from '../utils/logger';

// --- ALERTE PROJETS ---
// Pour chaque serveur configuré, on interroge MyGes avec le compte de référence
// de ce serveur et on annonce les nouveaux projets dans son salon d'alertes.
export async function checkNewProjects(client: Client) {
    const data = loadData();
    const guildIds = Object.keys(data.guilds);
    log('PROJET', `Vérification lancée · ${guildIds.length} serveur(s) enregistré(s)`);

    let detected = 0;
    for (const guildId of guildIds) {
        const cfg = getGuildConfig(data, guildId);

        if (!cfg.announcementChannelId || !cfg.referenceUserId) {
            log('PROJET', `Serveur ${guildId} : configuration incomplète (/config), ignoré.`);
            continue;
        }

        const token = sessions.get(cfg.referenceUserId);
        if (!token) {
            log('PROJET', `Serveur ${guildId} : compte de référence ${cfg.referenceUserId} non connecté, ignoré.`);
            continue;
        }

        const channel = (await client.channels.fetch(cfg.announcementChannelId).catch(() => null)) as TextChannel;
        if (!channel) {
            logError('PROJET', `Serveur ${guildId} : salon d'alertes ${cfg.announcementChannelId} introuvable.`);
            continue;
        }

        try {
            const projects = await ProjectService.getProjects(token, getCurrentYear());
            log('PROJET', `Serveur ${guildId} : ${projects.length} projet(s) récupéré(s) · ${cfg.knownProjectIds.length} déjà connu(s)`);

            for (const p of projects) {
                // On ignore les projets déjà annoncés ici ou sans identifiant fiable.
                if (p.project_id == null || cfg.knownProjectIds.includes(p.project_id)) continue;

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

                log('PROJET', `Serveur ${guildId} : nouveau détecté #${p.project_id} "${p.name}" (${p.course_name})`);
                await channel.send({ embeds: [embed] });
                // On enregistre l'ID AVANT de continuer, pour ne jamais re-notifier
                // le même projet même en cas d'interruption ou d'erreur ultérieure.
                cfg.knownProjectIds.push(p.project_id);
                saveData(data);
                detected++;
                log('PROJET', `Serveur ${guildId} : annoncé + enregistré #${p.project_id} · ${cfg.knownProjectIds.length} connu(s)`);
            }
        } catch (e) {
            logError('PROJET', `Serveur ${guildId} : erreur de vérification :`, e);
        }
        await new Promise((r) => setTimeout(r, 5000));
    }
    log('PROJET', `Vérification terminée · ${detected} nouveau(x) projet(s) annoncé(s)`);
}
