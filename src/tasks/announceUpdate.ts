import { Client, TextChannel } from 'discord.js';
import { BOT_VERSION, UPDATE_CHANNEL_ID } from '../config';
import { loadData, saveData } from '../core/store';
import { buildChangelogEmbed } from '../commands/changelog';

// --- ANNONCE DE MISE À JOUR ---
// Au démarrage, si BOT_VERSION a changé depuis la dernière annonce, poste le
// changelog dans le salon dédié (sans ping) puis mémorise la version annoncée.
export async function announceUpdateIfNeeded(client: Client) {
    const data = loadData();

    if (data.lastAnnouncedVersion === BOT_VERSION) return; // déjà annoncée

    const channel = (await client.channels.fetch(UPDATE_CHANNEL_ID).catch(() => null)) as TextChannel;
    if (!channel) {
        console.error(`❌ Salon de MAJ introuvable (${UPDATE_CHANNEL_ID}), annonce ignorée.`);
        return;
    }

    try {
        await channel.send({
            embeds: [buildChangelogEmbed(client)],
            allowedMentions: { parse: [] }, // aucun ping (@everyone/@here/rôles)
        });
        console.log(`📣 Annonce de mise à jour ${BOT_VERSION} postée.`);

        data.lastAnnouncedVersion = BOT_VERSION;
        saveData(data);
    } catch (e) {
        console.error("❌ Échec de l'annonce de mise à jour :", e);
    }
}
