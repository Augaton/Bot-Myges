// Petit cache mémoire à durée de vie, borné en taille.
// Usage : éviter de rappeler l'API MyGes pour une donnée qu'on vient tout juste
// de récupérer (navigation à coups de flèches dans l'agenda, par exemple).

interface Entry<T> {
    value: T;
    expiresAt: number;
}

export class TtlCache<T> {
    private readonly ttlMs: number;
    private readonly maxEntries: number;
    private readonly map = new Map<string, Entry<T>>();

    constructor(ttlMs: number, maxEntries = 200) {
        this.ttlMs = ttlMs;
        this.maxEntries = maxEntries;
    }

    get(key: string): T | undefined {
        const hit = this.map.get(key);
        if (!hit) return undefined;
        if (hit.expiresAt <= Date.now()) {
            this.map.delete(key);
            return undefined;
        }
        return hit.value;
    }

    /** `ttlMs` remplace, pour cette entrée seulement, la durée de vie par défaut. */
    set(key: string, value: T, ttlMs = this.ttlMs): void {
        // Réinsertion : la clé repasse en fin d'ordre d'insertion, ce qui fait
        // de l'éviction ci-dessous un vrai « plus ancien d'abord ».
        this.map.delete(key);
        this.map.set(key, { value, expiresAt: Date.now() + ttlMs });

        while (this.map.size > this.maxEntries) {
            const oldest = this.map.keys().next();
            if (oldest.done) break;
            this.map.delete(oldest.value);
        }
    }

    /** Oublie toutes les entrées dont la clé commence par `prefix`. */
    deleteByPrefix(prefix: string): void {
        for (const key of this.map.keys()) {
            if (key.startsWith(prefix)) this.map.delete(key);
        }
    }
}
