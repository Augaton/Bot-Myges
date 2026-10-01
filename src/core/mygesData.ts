// Accès aux données MyGes avec un cache mémoire court, par utilisateur.
// Naviguer dans l'agenda, relancer /notes ou /profil coup sur coup ne rappelle
// plus MyGes à chaque fois. Les clés commencent par l'ID Discord : aucune
// donnée n'est partagée entre utilisateurs, et forgetUser() efface tout ce qui
// concerne un utilisateur (déconnexion, changement de compte).
import { TtlCache } from '../utils/ttlCache';
import { TimetableService } from '../myges/services/timetable';
import { ProfileService } from '../myges/services/profile';
import { ProjectService } from '../myges/services/project';
import { getCurrentYear } from '../config';
import type { GesAuthenticationToken } from '../myges/types/auth';

const TTL_MS = {
    timetable: 60_000,
    grades: 2 * 60_000,
    profile: 10 * 60_000,
    projects: 60_000,
};

const cache = new TtlCache<unknown>(TTL_MS.timetable, 500);
const inflight = new Map<string, Promise<unknown>>();

function cached<T>(userId: string, key: string, ttlMs: number, fetch: () => Promise<T>): Promise<T> {
    const fullKey = `${userId}|${key}`;
    const hit = cache.get(fullKey);
    if (hit !== undefined) return Promise.resolve(hit as T);

    // Deux demandes simultanées (double clic, alerte + commande…) partagent la
    // même requête. Une erreur n'est jamais mise en cache.
    let pending = inflight.get(fullKey) as Promise<T> | undefined;
    if (!pending) {
        pending = fetch()
            .then((value) => {
                cache.set(fullKey, value, ttlMs);
                return value;
            })
            .finally(() => inflight.delete(fullKey));
        inflight.set(fullKey, pending);
    }
    return pending;
}

/** Efface toutes les données en cache d'un utilisateur. */
export function forgetUser(userId: string) {
    cache.deleteByPrefix(`${userId}|`);
}

export function getTimetable(userId: string, token: GesAuthenticationToken, start: Date, end: Date): Promise<any[]> {
    return cached(userId, `agenda|${start.getTime()}|${end.getTime()}`, TTL_MS.timetable, async () =>
        (await TimetableService.getTimetable(token, start, end)) || []);
}

export function getGrades(userId: string, token: GesAuthenticationToken): Promise<any[]> {
    const year = getCurrentYear();
    return cached(userId, `grades|${year}`, TTL_MS.grades, async () => (await ProfileService.getGrades(token, year)) || []);
}

export function getProfile(userId: string, token: GesAuthenticationToken): Promise<any> {
    return cached(userId, 'profile', TTL_MS.profile, () => ProfileService.getProfile(token));
}

export function getProjects(userId: string, token: GesAuthenticationToken): Promise<any[]> {
    const year = getCurrentYear();
    return cached(userId, `projects|${year}`, TTL_MS.projects, async () => (await ProjectService.getProjects(token, year)) || []);
}
