// Gestion centralisée des sessions et de la persistance des identifiants.
import * as fs from 'node:fs';
import { GesAPI } from '../myges/ges-api';
import { BadCredentialsError } from '../myges/errors';
import { createKdfParams, decrypt, encrypt, isLegacy, useKdf } from '../crypto';
import { DB_FILE } from '../config';
import { log, logError } from '../utils/logger';
import type { EncryptedData, KdfParams } from '../crypto';
import type { GesAuthenticationToken } from '../myges/types/auth';

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

/** Alertes personnelles envoyées en MP (voir tasks/personalAlerts). */
export interface UserAlerts {
    grades: boolean; // MP à chaque nouvelle note
    reminders: boolean; // MP la veille et 2 h avant chaque rendu
    gradesYear?: string; // année scolaire des notes mémorisées
    // Empreintes (HMAC) des notes déjà signalées : aucune note n'est stockée en clair.
    knownGrades?: string[];
    // Rappels déjà envoyés → échéance (ms), purgés une fois l'échéance passée.
    reminded?: Record<string, number>;
}

export interface SavedData {
    users: { [discordId: string]: { user: EncryptedData; pass: EncryptedData } };
    guilds: { [guildId: string]: GuildConfig };
    alerts: { [discordId: string]: UserAlerts };
    crypto?: KdfParams;
}

// --- SOURCE DE VÉRITÉ UNIQUE ---
// Le fichier n'est lu qu'une fois : ensuite, tout le monde manipule le MÊME
// objet en mémoire. Deux bénéfices :
//  • plus de lecture + parse synchrones (donc bloquants) à chaque interaction ;
//  • plus de mises à jour perdues. Avant, deux flux concurrents chargeaient
//    chacun leur copie et la dernière écriture écrasait l'autre : un /login
//    pendant un cycle d'alertes projets pouvait effacer les identifiants.
let cache: SavedData | null = null;

/** Lit le fichier et prépare la clé de chiffrement. `dirty` : à réécrire aussitôt. */
function readFromDisk(): { data: SavedData; dirty: boolean } {
    // On laisse remonter une erreur de parsing (fichier corrompu) plutôt que de
    // renvoyer un objet vide qui écraserait ensuite toutes les données.
    const data = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf-8')) : {};
    data.users ??= {};
    data.guilds ??= {};
    data.alerts ??= {};

    let dirty = false;
    if (!data.crypto) {
        data.crypto = createKdfParams();
        dirty = true;
    }
    useKdf(data.crypto);
    if (migrateCredentials(data) > 0) dirty = true;
    return { data, dirty };
}

/**
 * Rechiffre avec la clé dérivée (scrypt) les identifiants encore à l'ancien
 * format. Une copie du fichier d'origine est conservée : seule une version
 * antérieure du bot (≤ 3.3) sait relire l'ancien format, en cas de retour arrière.
 */
function migrateCredentials(data: SavedData): number {
    const legacy = Object.entries(data.users).filter(([, c]) => isLegacy(c.user) || isLegacy(c.pass));
    if (!legacy.length) return 0;

    const backup = `${DB_FILE}.bak-avant-scrypt`;
    try {
        if (!fs.existsSync(backup)) {
            fs.copyFileSync(DB_FILE, backup);
            fs.chmodSync(backup, 0o600);
        }
    } catch (e) {
        // Sans sauvegarde, on ne touche à rien : l'ancien format reste lisible.
        logError('STORE', `Sauvegarde ${backup} impossible, migration du chiffrement reportée :`, e);
        return 0;
    }

    let migrated = 0;
    for (const [userId, creds] of legacy) {
        try {
            const user = decrypt(creds.user);
            const pass = decrypt(creds.pass);
            const next = { user: encrypt(user), pass: encrypt(pass) };
            // Vérification avant de remplacer : on ne perd jamais un identifiant.
            if (decrypt(next.user) !== user || decrypt(next.pass) !== pass) throw new Error('relecture incohérente');
            data.users[userId] = next;
            migrated++;
        } catch (e) {
            logError('STORE', `Identifiants de ${userId} laissés à l'ancien format (illisibles avec la clé actuelle) :`, e);
        }
    }
    log('STORE', `Chiffrement renforcé (scrypt) : ${migrated}/${legacy.length} compte(s) migré(s). Copie d'origine : ${backup}`);
    return migrated;
}

/**
 * Renvoie l'état partagé. L'objet est mutable : le modifier puis appeler
 * `saveData()` suffit à persister. Ne jamais en conserver une copie figée.
 */
export function loadData(): SavedData {
    if (!cache) {
        const { data, dirty } = readFromDisk();
        cache = data;
        if (dirty) saveData(data);
    }
    return cache;
}

/**
 * Préférences d'alertes d'un utilisateur (créées au besoin : tout est activé
 * par défaut). L'objet fait partie de `data` : le modifier puis saveData suffit.
 */
export function getUserAlerts(data: SavedData, userId: string): UserAlerts {
    data.alerts[userId] ??= { grades: true, reminders: true };
    return data.alerts[userId];
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

/**
 * Persiste l'état partagé. L'argument est optionnel (et ignoré s'il s'agit déjà
 * du cache) : il n'est là que pour rester compatible avec les appels existants.
 */
export function saveData(data: SavedData = loadData()) {
    // Un appelant qui aurait construit son propre objet remplace l'état courant.
    if (data !== cache) cache = data;

    // Écriture atomique (fichier temporaire + renommage) pour ne jamais laisser
    // un saved_data.json à moitié écrit, et log explicite en cas d'échec d'écriture.
    // Mode 0600 : le fichier contient des identifiants chiffrés, il ne doit pas
    // être lisible par les autres comptes de la machine.
    const tmp = `${DB_FILE}.tmp`;
    try {
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, DB_FILE);
        fs.chmodSync(DB_FILE, 0o600); // le renommage conserve les droits d'un fichier préexistant
    } catch (e) {
        logError('STORE', `Échec d'écriture de ${DB_FILE} (permissions ? disque plein ?) :`, e);
        try {
            fs.unlinkSync(tmp);
        } catch {
            /* pas de temporaire à nettoyer */
        }
    }
}

// --- SESSIONS MYGES ---
// Token MyGes en mémoire vive, indexé par ID Discord. Une session n'est plus
// rouverte pour tout le monde au démarrage : elle est rétablie à la demande,
// au premier usage, à partir des identifiants chiffrés. Avantages :
//  • le bot est pleinement utilisable dès son démarrage ;
//  • une panne de MyGes au moment d'un redémarrage ne laisse plus les
//    utilisateurs « déconnectés » jusqu'au redémarrage suivant.
const sessions = new Map<string, GesAuthenticationToken>();
const restoring = new Map<string, Promise<GesAuthenticationToken | null>>();

// Dernier échec de reconnexion par utilisateur.
const failures = new Map<string, { at: number; badCredentials: boolean }>();
// MyGes en panne : on ne le relance pas à chaque commande.
const RETRY_AFTER_FAILURE_MS = 60_000;

/** L'utilisateur a des identifiants enregistrés (qu'il ait une session ouverte ou non). */
export function hasAccount(userId: string): boolean {
    return !!loadData().users[userId];
}

export function sessionCount(): number {
    return sessions.size;
}

/** Cause du dernier échec de reconnexion, pour un message d'erreur précis. */
export function loginFailure(userId: string): 'bad-credentials' | 'unavailable' | null {
    const f = failures.get(userId);
    if (!f) return null;
    return f.badCredentials ? 'bad-credentials' : 'unavailable';
}

/** Ouvre une session après un /login réussi (efface tout échec antérieur). */
export function openSession(userId: string, token: GesAuthenticationToken) {
    failures.delete(userId);
    sessions.set(userId, makeSession(userId, token));
}

export function closeSession(userId: string) {
    sessions.delete(userId);
    failures.delete(userId);
}

/**
 * Session MyGes de l'utilisateur, rétablie si besoin à partir des identifiants
 * enregistrés. null s'il n'a pas de compte ou si la reconnexion échoue.
 */
export async function getSession(userId: string): Promise<GesAuthenticationToken | null> {
    const active = sessions.get(userId);
    if (active) return active;

    const creds = loadData().users[userId];
    if (!creds) return null;

    const failure = failures.get(userId);
    // Identifiants refusés : on n'insiste pas, des essais répétés avec un mot de
    // passe périmé risqueraient de faire verrouiller le compte MyGes. Seul un
    // nouveau /login lève le blocage.
    if (failure?.badCredentials) return null;
    if (failure && Date.now() - failure.at < RETRY_AFTER_FAILURE_MS) return null;

    // Plusieurs commandes simultanées ne déclenchent qu'une seule connexion.
    let pending = restoring.get(userId);
    if (!pending) {
        pending = restore(userId, creds).finally(() => restoring.delete(userId));
        restoring.set(userId, pending);
    }
    return pending;
}

async function restore(userId: string, creds: SavedData['users'][string]): Promise<GesAuthenticationToken | null> {
    try {
        const token = await GesAPI.login(decrypt(creds.user), decrypt(creds.pass));
        // Entre-temps, l'utilisateur a pu se déconnecter ou se reconnecter avec
        // d'autres identifiants : on ne réinstalle pas une session périmée.
        if (loadData().users[userId] !== creds) return sessions.get(userId) ?? null;
        failures.delete(userId);
        const session = makeSession(userId, token);
        sessions.set(userId, session);
        log('AUTH', `Session MyGes rétablie pour ${userId}.`);
        return session;
    } catch (e) {
        const badCredentials = e instanceof BadCredentialsError;
        failures.set(userId, { at: Date.now(), badCredentials });
        if (badCredentials) logError('AUTH', `Reconnexion de ${userId} : identifiants refusés par MyGes (refaire /login).`);
        else logError('AUTH', `Reconnexion de ${userId} impossible :`, e);
        return null;
    }
}

// Session auto-rafraîchissante : BaseService appelle __refresh en cas de 401 ou
// d'expiration imminente du token, pour se reconnecter de façon transparente.
function makeSession(userId: string, token: GesAuthenticationToken): GesAuthenticationToken {
    let refreshing: Promise<GesAuthenticationToken | null> | null = null;
    return {
        token_type: token.token_type,
        access_token: token.access_token,
        expires_at: token.expires_at,
        // Plusieurs requêtes peuvent constater l'expiration en même temps : une
        // seule reconnexion, partagée par toutes.
        __refresh: () => {
            refreshing ??= refreshToken(userId).finally(() => {
                refreshing = null;
            });
            return refreshing;
        },
    };
}

async function refreshToken(userId: string): Promise<GesAuthenticationToken | null> {
    const creds = loadData().users[userId];
    if (!creds) {
        sessions.delete(userId);
        return null;
    }
    try {
        const fresh = await GesAPI.login(decrypt(creds.user), decrypt(creds.pass));
        log('AUTH', `Token rafraîchi pour ${userId}.`);
        return fresh;
    } catch (e) {
        if (e instanceof BadCredentialsError) {
            // Mot de passe changé côté MyGes : la session n'est plus récupérable.
            sessions.delete(userId);
            failures.set(userId, { at: Date.now(), badCredentials: true });
            logError('AUTH', `Rafraîchissement pour ${userId} : identifiants refusés par MyGes (refaire /login).`);
        } else {
            logError('AUTH', `Échec du rafraîchissement de token pour ${userId} :`, e);
        }
        return null;
    }
}
