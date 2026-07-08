// Gestion centralisée des sessions et de la persistance des identifiants.
import * as fs from 'fs';
import { GesAPI } from '../myges/ges-api';
import { decrypt } from '../crypto';
import { DB_FILE } from '../config';
import type { EncryptedData } from '../crypto';

export interface SavedData {
    users: { [discordId: string]: { user: EncryptedData; pass: EncryptedData } };
    knownProjectIds: number[];
    // Dernière version du bot annoncée dans le salon des MAJ (évite de re-poster).
    lastAnnouncedVersion?: string;
}

// Sessions actives (token MyGes en mémoire vive), indexées par ID Discord.
export const sessions = new Map<string, any>();

export function loadData(): SavedData {
    if (!fs.existsSync(DB_FILE)) return { users: {}, knownProjectIds: [] };
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
}

export function saveData(data: SavedData) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
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
