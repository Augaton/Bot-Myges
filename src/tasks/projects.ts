import { Client, EmbedBuilder, TextChannel } from 'discord.js';
import { ProjectService } from '../myges/services/project';
import { getCurrentYear } from '../config';
import { getGuildConfig, loadData, saveData, sessions } from '../core/store';
import { getNextStep } from '../utils/format';
import { log, logError } from '../utils/logger';

// --- ALERTE PROJETS ---
// Pour chaque serveur configuré, on annonce les nouveaux projets du compte de
// référence dans son salon d'alertes. Les serveurs partageant le même compte de
// référence sont regroupés : une seule requête API sert à tous.
export async function checkNewProjects(client: Client) {
    const data = loadData();
    const guildIds = Object.keys(data.guilds);

    // 1. Regroupement des serveurs par compte de référence.
    const guildsByUser = new Map<string, string[]>();
    for (const guildId of guildIds) {
        const cfg = getGuildConfig(data, guildId);

        if (!cfg.announcementChannelId || !cfg.referenceUserId) {
            log('PROJET', `Serveur ${guildId} : configuration incomplète (/config), ignoré.`);
            continue;
        }
        if (!sessions.has(cfg.referenceUserId)) {
            log('PROJET', `Serveur ${guildId} : compte de référence ${cfg.referenceUserId} non connecté, ignoré.`);
            continue;
        }

        const list = guildsByUser.get(cfg.referenceUserId) ?? [];
        list.push(guildId);
        guildsByUser.set(cfg.referenceUserId, list);
    }

    log('PROJET', `Vérification lancée · ${guildIds.length} serveur(s) enregistré(s) · ${guildsByUser.size} compte(s) de référence à interroger`);

    // 2. Une requête API par compte de référence (et non par serveur).
    let detected = 0;
    let firstCall = true;
    for (const [userId, guilds] of guildsByUser) {
        // Temporisation uniquement ENTRE deux appels API réels.
        if (!firstCall) await new Promise((r) => setTimeout(r, 5000));
        firstCall = false;

        const token = sessions.get(userId);
        let projects: any[];
        try {
            projects = await ProjectService.getProjects(token, getCurrentYear());
        } catch (e) {
            logError('PROJET', `Compte ${userId} : récupération des projets impossible :`, e);
            continue;
        }
        log('PROJET', `Compte ${userId} : ${projects.length} projet(s) récupéré(s) · ${guilds.length} serveur(s) concerné(s)`);

        // 3. Diffusion sur chaque serveur, avec son propre historique.
        for (const guildId of guilds) {
            const cfg = getGuildConfig(data, guildId);
            const channel = (await client.channels.fetch(cfg.announcementChannelId!).catch(() => null)) as TextChannel;
            if (!channel) {
                logError('PROJET', `Serveur ${guildId} : salon d'alertes ${cfg.announcementChannelId} introuvable.`);
                continue;
            }

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
                try {
                    await channel.send({ embeds: [embed] });
                } catch (e) {
                    logError('PROJET', `Serveur ${guildId} : envoi de l'alerte #${p.project_id} impossible :`, e);
                    continue; // on n'enregistre pas : on réessaiera au prochain cycle
                }
                // On enregistre l'ID AVANT de continuer, pour ne jamais re-notifier
                // le même projet même en cas d'interruption ou d'erreur ultérieure.
                cfg.knownProjectIds.push(p.project_id);
                saveData(data);
                detected++;
                log('PROJET', `Serveur ${guildId} : annoncé + enregistré #${p.project_id} · ${cfg.knownProjectIds.length} connu(s)`);
            }
        }
    }
    log('PROJET', `Vérification terminée · ${detected} nouvelle(s) alerte(s) envoyée(s)`);
}
