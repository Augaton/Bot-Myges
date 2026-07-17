// Gestion centralisée des sessions et de la persistance des identifiants.
import * as fs from 'fs';
import { GesAPI } from '../myges/ges-api';
import { decrypt } from '../crypto';
import { DB_FILE } from '../config';
import type { EncryptedData } from '../crypto';

/**
 * Configuration propre à un serveur Discord. Un même bot peut ainsi servir
 * plusieurs serveurs (ex : une promo par serveur) avec des réglages distincts.
 */
export interface GuildConfig {
    // Salon où poster les alertes de nouveaux projets.
    announcementChannelId?: string;
    // Salon où poster les annonces de mise à jour du bot.
    updateChannelId?: string;
    // Compte MyGes (utilisateur Discord connecté) servant de référence pour ce
    // serveur : c'est son emploi du temps / ses projets qui alimentent les alertes.
    referenceUserId?: string;
    // Projets déjà annoncés sur CE serveur (évite les doublons).
    knownProjectIds: number[];
    // Dernière version du bot annoncée sur CE serveur.
    lastAnnouncedVersion?: string;
}

export interface SavedData {
    users: { [discordId: string]: { user: EncryptedData; pass: EncryptedData } };
    guilds: { [guildId: string]: GuildConfig };
}

// Sessions actives (token MyGes en mémoire vive), indexées par ID Discord.
export const sessions = new Map<string, any>();

export function loadData(): SavedData {
    if (!fs.existsSync(DB_FILE)) return { users: {}, guilds: {} };
    // On laisse remonter une erreur de parsing (fichier corrompu) plutôt que de
    // renvoyer un objet vide qui écraserait ensuite toutes les données.
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    if (!parsed.users) parsed.users = {};
    if (!parsed.guilds) parsed.guilds = {};
    return parsed;
}

/**
 * Récupère (en la créant au besoin) la configuration d'un serveur.
 * L'objet renvoyé fait partie de `data` : le modifier puis appeler saveData suffit.
 */
export function getGuildConfig(data: SavedData, guildId: string): GuildConfig {
    if (!data.guilds[guildId]) data.guilds[guildId] = { knownProjectIds: [] };
    const cfg = data.guilds[guildId];
    if (!Array.isArray(cfg.knownProjectIds)) cfg.knownProjectIds = [];
    return cfg;
}

export function saveData(data: SavedData) {
    // Écriture atomique (fichier temporaire + renommage) pour ne jamais laisser
    // un saved_data.json à moitié écrit, et log explicite en cas d'échec d'écriture.
    try {
        const tmp = `${DB_FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
        fs.renameSync(tmp, DB_FILE);
    } catch (e) {
        console.error(`❌ Échec d'écriture de ${DB_FILE} (permissions ? disque plein ?) :`, e);
    }
}

// --- SESSION AUTO-RAFRAÎCHISSANTE ---
// On enveloppe le token avec une fonction __refresh que BaseService appellera
// automatiquement en cas de 401 (token MyGes expiré), en réutilisant les
// identifiants chiffrés sur disque pour se reconnecter de façon transparente.
export function makeSession(userId: string, token: { token_type: string; access_token: string }) {
    return {
        token_type: token.token_type,
        access_token: token.access_token,
        __refresh: async () => {
            const data = loadData();
            const creds = data.users[userId];
            if (!creds) {
                sessions.delete(userId);
                return null;
            }
            try {
                const fresh = await GesAPI.login(decrypt(creds.user), decrypt(creds.pass));
                console.log(`🔁 Token rafraîchi pour ${userId}`);
                return fresh;
            } catch (e) {
                console.error(`❌ Échec du rafraîchissement de token pour ${userId}`, e);
                return null;
            }
        },
    };
}
