// Réglages globaux du bot.
// Tout ce qui est propre à un serveur (salons, compte de référence) se configure
// en jeu via la commande /config, et non plus ici.
//
// Ce module doit être le PREMIER importé (voir index.ts) : il charge le .env et
// fixe le fuseau horaire avant que quoi que ce soit ne manipule une date.

import * as fs from 'node:fs';
import * as path from 'node:path';

// Racine du projet : __dirname vaut `src/` en dev et `dist/` après build.
const ROOT = path.resolve(__dirname, '..');

// --- .env ---
// Chargé nativement par Node (plus de dépendance dotenv). Les variables déjà
// présentes dans l'environnement (systemd, Docker…) restent prioritaires.
try {
    process.loadEnvFile(path.join(ROOT, '.env'));
} catch (e: any) {
    if (e?.code !== 'ENOENT') console.error('⚠️ .env illisible, variables d\'environnement seules utilisées :', e);
}

// --- FUSEAU HORAIRE ---
// Toutes les dates du bot (agenda, sélecteur de semaine, rappels, logs) sont
// celles de l'école. Sans ça, un serveur réglé en UTC décalait l'emploi du temps
// de 1 à 2 h : un cours de 9 h était dessiné sur la ligne de 7 h. Node prend en
// compte l'affectation de TZ à chaud, workers de rendu compris.
export const TIMEZONE = 'Europe/Paris';
process.env.TZ = TIMEZONE;

/**
 * Code de sortie des erreurs de configuration (token absent, clé invalide…).
 * Le superviseur (index.js) ne relance pas le bot sur ce code : relancer en
 * boucle n'y changerait rien.
 */
export const EXIT_CONFIG = 78;

export const CHECK_INTERVAL = 60 * 60 * 1000;

/**
 * Fichier de persistance. Résolu depuis la racine du projet (et non depuis le
 * répertoire courant) : un lancement via systemd ou depuis un autre dossier
 * pointe ainsi toujours sur le même fichier. Surchargeable via DB_FILE.
 */
export const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'saved_data.json');

/** Codes d'accès des campus (hors dépôt, voir campus.example.json). */
export const CAMPUS_FILE = process.env.CAMPUS_FILE || path.join(ROOT, 'campus.json');

// Version unique, lue dans package.json : plus de second numéro à tenir à jour.
// Changer la version déclenche l'annonce de mise à jour sur chaque serveur.
export const BOT_VERSION = `v${JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version}`;

/**
 * Propriétaire(s) du bot : peuvent utiliser /config sur n'importe quel serveur,
 * même sans y être administrateurs. Surchargeable via OWNER_IDS (IDs Discord
 * séparés par des virgules).
 */
const OWNER_IDS = new Set(
    (process.env.OWNER_IDS || '456653480048852995').split(',').map((id) => id.trim()).filter(Boolean)
);

export function isBotOwner(userId: string): boolean {
    return OWNER_IDS.has(userId);
}

/**
 * Année scolaire courante au format attendu par l'API MyGes (ex: "2025" pour
 * l'année 2025-2026). Calculée dynamiquement : de septembre à décembre on est
 * sur l'année en cours, de janvier à août on est encore sur l'année précédente.
 */
export function getCurrentYear(): string {
    const now = new Date();
    // getMonth() : 0 = janvier ... 8 = septembre
    const year = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
    return String(year);
}
