import { Client } from 'discord.js';
import { BOT_VERSION } from '../config';
import { getGuildConfig, loadData, saveData } from '../core/store';
import { buildChangelogEmbed } from '../commands/changelog';
import { log, logError } from '../utils/logger';

/** Même version mineure (v4.5.0 → v4.5.1) : un correctif, rien de nouveau à annoncer. */
export function isPatchOnly(previous: string | undefined, next: string): boolean {
    const minor = (version: string) => version.replace(/^v/, '').split('.').slice(0, 2).join('.');
    return !!previous && minor(previous) === minor(next);
}

// --- ANNONCE DE MISE À JOUR ---
// Au démarrage, pour chaque serveur ayant configuré un salon de MAJ (/config),
// poste le changelog si BOT_VERSION a changé depuis la dernière annonce sur CE
// serveur, puis mémorise la version annoncée (aucun ping).
export async function announceUpdateIfNeeded(client: Client) {
    const data = loadData();
    const guildIds = Object.keys(data.guilds);

    for (const guildId of guildIds) {
        const cfg = getGuildConfig(data, guildId);

        if (!cfg.updateChannelId) continue; // salon de MAJ non configuré
        if (cfg.lastAnnouncedVersion === BOT_VERSION) {
            log('MAJ', `Serveur ${guildId} : ${BOT_VERSION} déjà annoncée.`);
            continue;
        }

        // Version corrective : l'annonce de la version mineure, déjà faite, suffit.
        if (isPatchOnly(cfg.lastAnnouncedVersion, BOT_VERSION)) {
            log('MAJ', `Serveur ${guildId} : ${BOT_VERSION} est un correctif de ${cfg.lastAnnouncedVersion}, pas d'annonce.`);
            cfg.lastAnnouncedVersion = BOT_VERSION;
            saveData(data);
            continue;
        }

        log('MAJ', `Serveur ${guildId} : nouvelle version ${BOT_VERSION} (précédente : ${cfg.lastAnnouncedVersion ?? 'aucune'}) → annonce`);

        const channel = await client.channels.fetch(cfg.updateChannelId).catch(() => null);
        if (!channel?.isSendable()) {
            logError('MAJ', `Serveur ${guildId} : salon de MAJ ${cfg.updateChannelId} introuvable ou inaccessible, annonce ignorée.`);
            continue;
        }

        try {
            await channel.send({
                embeds: [buildChangelogEmbed(client)],
                allowedMentions: { parse: [] }, // aucun ping (@everyone/@here/rôles)
            });
            cfg.lastAnnouncedVersion = BOT_VERSION;
            saveData(data);
            log('MAJ', `Serveur ${guildId} : annonce ${BOT_VERSION} postée et mémorisée.`);
        } catch (e) {
            logError('MAJ', `Serveur ${guildId} : échec de l'annonce :`, e);
        }
    }
}
