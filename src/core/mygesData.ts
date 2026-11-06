// Accès aux données MyGes avec un cache mémoire court, par utilisateur.
// Naviguer dans l'agenda, relancer /notes ou /profil coup sur coup ne rappelle
// plus MyGes à chaque fois. Les clés commencent par l'ID Discord : aucune
// donnée n'est partagée entre utilisateurs, et forgetUser() efface tout ce qui
// concerne un utilisateur (déconnexion, changement de compte).
import { TtlCache } from '../utils/ttlCache';
import { TimetableService } from '../myges/services/timetable';
import { ProfileService } from '../myges/services/profile';
import { ProjectService } from '../myges/services/project';
import { SchoolService } from '../myges/services/school';
import { getCurrentYear } from '../utils/schoolYear';
import { logError } from '../utils/logger';
import type { GesAuthenticationToken } from '../myges/types/auth';

const TTL_MS = {
    // L'agenda bouge peu, et naviguer dans /agenda repasse souvent par les mêmes semaines.
    timetable: 5 * 60_000,
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
    const shared = inflight.get(fullKey) as Promise<T> | undefined;
    if (shared) return shared;

    const pending: Promise<T> = fetch()
        .then((value) => {
            // Sinon, l'utilisateur a été oublié pendant la lecture (déconnexion, autre
            // compte MyGes) : ces données ne doivent pas rentrer dans le cache.
            if (inflight.get(fullKey) === pending) cache.set(fullKey, value, ttlMs);
            return value;
        })
        .finally(() => {
            if (inflight.get(fullKey) === pending) inflight.delete(fullKey);
        });
    inflight.set(fullKey, pending);
    return pending;
}

/** Efface toutes les données en cache d'un utilisateur. */
export function forgetUser(userId: string) {
    const prefix = `${userId}|`;
    cache.deleteByPrefix(prefix);
    // Une lecture encore en cours ne sera partagée avec personne d'autre.
    for (const key of inflight.keys()) {
        if (key.startsWith(prefix)) inflight.delete(key);
    }
}

/** Oublie projets et TP lus : après un changement d'équipe, il faut relire MyGes. */
export function forgetAssignments(userId: string) {
    for (const kind of ['projects', 'practicals']) {
        const prefix = `${userId}|${kind}|`;
        cache.deleteByPrefix(prefix);
        for (const key of inflight.keys()) {
            if (key.startsWith(prefix)) inflight.delete(key);
        }
    }
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

export function getAbsences(userId: string, token: GesAuthenticationToken): Promise<any[]> {
    const year = getCurrentYear();
    return cached(userId, `absences|${year}`, TTL_MS.grades, async () => (await ProfileService.getAbsences(token, year)) || []);
}

export function getCourses(userId: string, token: GesAuthenticationToken): Promise<any[]> {
    const year = getCurrentYear();
    return cached(userId, `courses|${year}`, TTL_MS.profile, async () => (await ProfileService.getCourses(token, year)) || []);
}

export function getSyllabus(userId: string, token: GesAuthenticationToken, rcId: string): Promise<any> {
    return cached(userId, `syllabus|${rcId}`, TTL_MS.profile, () => ProfileService.getSyllabus(token, rcId));
}

export function getEvents(userId: string, token: GesAuthenticationToken): Promise<any[]> {
    return cached(userId, 'events', TTL_MS.profile, async () => (await SchoolService.getEvents(token)) || []);
}

export function getNews(userId: string, token: GesAuthenticationToken): Promise<any> {
    return cached(userId, 'news', TTL_MS.profile, async () => (await SchoolService.getNews(token)) ?? []);
}

export function getProjects(userId: string, token: GesAuthenticationToken): Promise<any[]> {
    const year = getCurrentYear();
    return cached(userId, `projects|${year}`, TTL_MS.projects, async () => (await ProjectService.getProjects(token, year)) || []);
}

function getPracticals(userId: string, token: GesAuthenticationToken): Promise<any[]> {
    const year = getCurrentYear();
    return cached(userId, `practicals|${year}`, TTL_MS.projects, async () => (await ProjectService.getPracticals(token, year)) || []);
}

/**
 * Projets et TP réunis, pour /projets et les rappels. Les TP sont marqués
 * `practical` et ne servent qu'en complément : un échec sur leur route ne doit
 * pas priver l'utilisateur de ses projets. Les annonces de nouveaux projets sur
 * les serveurs restent sur getProjects, sinon tous les TP existants y partiraient
 * d'un coup à la mise à jour.
 */
export async function getAssignments(userId: string, token: GesAuthenticationToken): Promise<any[]> {
    const [projects, practicals] = await Promise.all([
        getProjects(userId, token),
        getPracticals(userId, token).catch((e): any[] => {
            logError('MYGES', `Compte ${userId} : lecture des TP impossible :`, e);
            return [];
        }),
    ]);
    if (!Array.isArray(practicals)) return projects;
    const known = new Set(projects.map((p) => p?.project_id));
    return [...projects, ...practicals.filter((p) => !known.has(p?.project_id)).map((p) => ({ ...p, practical: true }))];
}
