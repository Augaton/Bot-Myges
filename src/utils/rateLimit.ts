// Limite de fréquence par clé (ID Discord…), sur une fenêtre glissante.

export class RateLimiter {
    private readonly max: number;
    private readonly windowMs: number;
    private readonly hits = new Map<string, number[]>();

    constructor(max: number, windowMs: number) {
        this.max = max;
        this.windowMs = windowMs;
    }

    /** Vrai si `key` a atteint la limite ; ne compte aucun passage. */
    full(key: string): boolean {
        const now = Date.now();
        return (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs).length >= this.max;
    }

    /** Enregistre un passage ; faux si `key` a déjà atteint la limite (rien n'est alors compté). */
    hit(key: string): boolean {
        const now = Date.now();
        // Ménage à chaque passage : la map ne garde que les utilisateurs récents.
        for (const [k, times] of this.hits) {
            if (now - times[times.length - 1] >= this.windowMs) this.hits.delete(k);
        }
        const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
        if (recent.length >= this.max) return false;
        this.hits.set(key, [...recent, now]);
        return true;
    }
}
