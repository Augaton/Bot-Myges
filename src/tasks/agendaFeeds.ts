// Abonnements d'agenda. Pour chaque abonné, le bot prépare ses 12 prochaines semaines de
// cours, chiffrées avec le secret de son lien (voir utils/feedSeal). Le secret, lui, est
// gardé chiffré avec la clé du bot, comme les identifiants. Le panel sert le fichier
// sans jamais avoir cette clé. Seul le bot peut renouveler le token MyGes : c'est donc
// lui qui tient l'abonnement à jour.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FEEDS_DIR } from '../config';
import { getTimetable } from '../core/mygesData';
import { getSession, loadData, saveData } from '../core/store';
import { decrypt, encrypt } from '../crypto';
import { addDays, getMonday } from '../utils/datePicker';
import { feedId, newFeedSecret, sealFeed } from '../utils/feedSeal';
import { buildIcs, ICS_WEEKS } from '../utils/ics';
import { logError } from '../utils/logger';
import type { GesAuthenticationToken } from '../myges/types/auth';

export const FEED_INTERVAL = 30 * 60_000;
const PAUSE_BETWEEN_USERS_MS = 2_000;

const fileOf = (secret: string) => path.join(FEEDS_DIR, `${feedId(secret)}.json`);

/** Secret du lien de cet utilisateur, s'il en a un. */
export function feedSecret(userId: string): string | null {
    const entry = loadData().feeds?.[userId];
    if (!entry) return null;
    try {
        return decrypt(entry.secret);
    } catch {
        return null;
    }
}

/** Supprime l'abonnement et son fichier : le lien cesse aussitôt de fonctionner. Vrai s'il existait. */
export function removeFeed(userId: string): boolean {
    const data = loadData();
    if (!data.feeds?.[userId]) return false;
    const secret = feedSecret(userId);
    if (secret) fs.rmSync(fileOf(secret), { force: true });
    delete data.feeds[userId];
    saveData(data);
    return true;
}

/** Nouveau lien ; l'ancien, s'il y en avait un, cesse de fonctionner. */
export function createFeed(userId: string): string {
    removeFeed(userId);
    const secret = newFeedSecret();
    const data = loadData();
    (data.feeds ??= {})[userId] = { secret: encrypt(secret) };
    saveData(data);
    return secret;
}

/** Écrit les 12 prochaines semaines, chiffrées. Écriture atomique, lisible par le seul compte du bot. */
export async function refreshFeed(userId: string, secret: string, token: GesAuthenticationToken) {
    const monday = getMonday(new Date());
    const end = addDays(monday, ICS_WEEKS * 7 - 1);
    end.setHours(23, 59, 59);
    const ics = buildIcs(await getTimetable(userId, token, monday, end));
    // Pendant la lecture, le lien a pu être supprimé ou remplacé (/logout, nouveau lien) :
    // ne pas recréer son fichier. Vérification et écriture sont synchrones, sans attente
    // entre elles : rien ne peut s'intercaler.
    if (feedSecret(userId) !== secret) return;
    fs.mkdirSync(FEEDS_DIR, { recursive: true, mode: 0o700 });
    const file = fileOf(secret);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(sealFeed(secret, ics)), { mode: 0o600 });
    fs.renameSync(tmp, file);
}

let running = false;

/** Met à jour tous les abonnements, puis retire les fichiers qui ne servent plus. */
export async function runFeedRefresh() {
    if (running) return;
    running = true;
    try {
        let pause = false;
        for (const userId of Object.keys(loadData().feeds ?? {})) {
            const secret = feedSecret(userId);
            if (!secret) continue;
            if (pause) await new Promise((resolve) => setTimeout(resolve, PAUSE_BETWEEN_USERS_MS));
            pause = true;
            // Pas de session (MyGes en panne, mot de passe changé) : le dernier fichier reste servi.
            const token = await getSession(userId);
            if (!token) continue;
            try {
                await refreshFeed(userId, secret, token);
            } catch (e) {
                logError('AGENDA', `${userId} : abonnement non mis à jour :`, e);
            }
        }
        // Liste relue maintenant, pas au début du passage : un lien créé entre-temps garde son fichier.
        const valid = new Set(Object.keys(loadData().feeds ?? {})
            .map(feedSecret)
            .filter((secret): secret is string => secret !== null)
            .map((secret) => `${feedId(secret)}.json`));
        for (const name of fs.existsSync(FEEDS_DIR) ? fs.readdirSync(FEEDS_DIR) : []) {
            if (!valid.has(name)) fs.rmSync(path.join(FEEDS_DIR, name), { force: true });
        }
    } catch (e) {
        logError('AGENDA', 'Mise à jour des abonnements en échec :', e);
    } finally {
        running = false;
    }
}
