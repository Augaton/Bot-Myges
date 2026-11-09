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

/** "2025" → "2025-2026". */
export function yearLabel(year: string): string {
    return `${year}-${Number(year) + 1}`;
}

/** Les dernières années : repli de l'autocomplétion quand MyGes ne peut pas répondre à temps. */
export function yearChoices(count = 5): { name: string; value: string }[] {
    const current = Number(getCurrentYear());
    return Array.from({ length: count }, (_, i) => {
        const year = String(current - i);
        return { name: i === 0 ? `${yearLabel(year)} (en cours)` : yearLabel(year), value: year };
    });
}
