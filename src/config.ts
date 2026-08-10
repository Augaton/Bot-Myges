// Réglages globaux du bot.
// Tout ce qui est propre à un serveur (salons, compte de référence) se configure
// désormais en jeu via la commande /config, et non plus ici.

export const CHECK_INTERVAL = 60 * 60 * 1000;
export const DB_FILE = './saved_data.json';

// BOT VERSION
export const BOT_VERSION = 'v3.1.0';

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
