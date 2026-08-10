// Réglages globaux du bot.
// Tout ce qui est propre à un serveur (salons, compte de référence) se configure
// désormais en jeu via la commande /config, et non plus ici.

import * as path from 'path';
import * as dotenv from 'dotenv';

// Ce module est importé très tôt (avant le corps de index.ts) : on charge le
// .env ici pour que DB_FILE soit lisible dès la résolution des constantes.
dotenv.config({ quiet: true });

export const CHECK_INTERVAL = 60 * 60 * 1000;

/**
 * Fichier de persistance. Résolu depuis la racine du projet (et non depuis le
 * répertoire courant) : un lancement via systemd ou depuis un autre dossier
 * pointe ainsi toujours sur le même fichier. Surchargeable via DB_FILE.
 * __dirname vaut `src/` en dev et `dist/` après build : `..` = racine dans les deux cas.
 */
export const DB_FILE = process.env.DB_FILE || path.resolve(__dirname, '..', 'saved_data.json');

// BOT VERSION
export const BOT_VERSION = 'v3.3.0';

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
