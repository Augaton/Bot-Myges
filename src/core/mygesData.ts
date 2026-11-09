// Accès aux données MyGes avec un cache mémoire court, par utilisateur.
// Naviguer dans l'agenda, relancer /notes ou /profil coup sur coup ne rappelle
// plus MyGes à chaque fois. Les clés commencent par l'ID Discord : aucune
// donnée n'est partagée entre utilisateurs, et forgetUser() efface tout ce qui
// concerne un utilisateur (déconnexion, changement de compte).
import { TtlCache } from '../utils/ttlCache';
import { TimetableService } from '../myges/services/timetable';
import { DocumentService } from '../myges/services/document';
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
    documents: 5 * 60_000,
    // Une année terminée ne bouge presque plus : relue au plus une fois par heure.
    archive: 60 * 60_000,
};

/** Cache d'une donnée annuelle : court pour l'année en cours, long pour une année passée. */
const ttlFor = (year: string, ttl: number) => (year === getCurrentYear() ? ttl : TTL_MS.archive);

// Plus d'entrées qu'il n'y paraît : l'écran Documents du panel lit toutes les matières.
const cache = new TtlCache<unknown>(TTL_MS.timetable, 2_000);
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

export function getCourseFiles(userId: string, token: GesAuthenticationToken, rcId: string) {
    return cached(userId, `files|${rcId}`, TTL_MS.documents, () => DocumentService.getCourseFiles(token, rcId));
}

export function getAnnualDocuments(userId: string, token: GesAuthenticationToken, year = getCurrentYear()) {
    return cached(userId, `annual|${year}`, ttlFor(year, TTL_MS.documents), () => DocumentService.getAnnualDocuments(token, year));
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

export function getGrades(userId: string, token: GesAuthenticationToken, year = getCurrentYear()): Promise<any[]> {
    return cached(userId, `grades|${year}`, ttlFor(year, TTL_MS.grades), async () => (await ProfileService.getGrades(token, year)) || []);
}

export function getProfile(userId: string, token: GesAuthenticationToken): Promise<any> {
    return cached(userId, 'profile', TTL_MS.profile, () => ProfileService.getProfile(token));
}

export function getAbsences(userId: string, token: GesAuthenticationToken, year = getCurrentYear()): Promise<any[]> {
    return cached(userId, `absences|${year}`, ttlFor(year, TTL_MS.grades), async () => (await ProfileService.getAbsences(token, year)) || []);
}

export function getCourses(userId: string, token: GesAuthenticationToken, year = getCurrentYear()): Promise<any[]> {
    return cached(userId, `courses|${year}`, ttlFor(year, TTL_MS.profile), async () => (await ProfileService.getCourses(token, year)) || []);
}

export function getSyllabus(userId: string, token: GesAuthenticationToken, rcId: string): Promise<any> {
    return cached(userId, `syllabus|${rcId}`, TTL_MS.profile, () => ProfileService.getSyllabus(token, rcId));
}

export function getEvents(userId: string, token: GesAuthenticationToken): Promise<any[]> {
    return cached(userId, 'events', TTL_MS.profile, async () => (await SchoolService.getEvents(token)) || []);
}

const photoLink = (person: any): string | null =>
    person?._links?.photo?.href ?? (Array.isArray(person?.links) ? person.links.find((l: any) => l?.rel === 'photo')?.href : null) ?? null;

/** Une personne de l'annuaire. L'adresse de sa photo ne quitte jamais le serveur. */
export interface DirectoryPerson {
    id: string;
    firstname: string;
    lastname: string;
    email: string;
    photo: string | null;
    /** Promotion d'où vient la personne (annuaire étendu sur plusieurs années). */
    group?: string;
}

function toPerson(raw: any, withEmail: boolean): DirectoryPerson | null {
    if (raw?.uid == null) return null;
    return {
        id: String(raw.uid),
        firstname: String(raw?.firstname ?? ''),
        lastname: String(raw?.lastname ?? ''),
        // L'adresse d'un camarade n'a pas à rester en mémoire : seul un intervenant se contacte d'ici.
        email: withEmail ? String(raw?.email ?? '') : '',
        photo: photoLink(raw),
    };
}

const photoMap = (people: DirectoryPerson[]): Record<string, string> =>
    Object.fromEntries(people.flatMap((person) => (person.photo ? [[person.id, person.photo]] : [])));

export function getClasses(userId: string, token: GesAuthenticationToken): Promise<any[]> {
    const year = getCurrentYear();
    return cached(userId, `classes|${year}`, TTL_MS.profile, async () => {
        const classes: any = await SchoolService.getMyClasses(token, year);
        return Array.isArray(classes) ? classes : [];
    });
}

// Annuaire étendu aux promotions : les classes de l'étudiant, sur chacune de ses années
// d'inscription. MyGes n'a pas d'annuaire de toute l'école (`/me/{année}/students`
// répond 418), et balayer les identifiants un à un collecterait des inconnus.

// Années proposées quand MyGes ne les donne pas : un cursus bachelor (3) puis master (2).
const RECENT_YEARS = 5;

async function studentsOfYear(token: GesAuthenticationToken, year: string): Promise<DirectoryPerson[]> {
    const classes: any = await SchoolService.getMyClasses(token, year);
    // Les classes d'une année sont lues ensemble : une attente au lieu d'une par classe.
    const lists = await Promise.all((Array.isArray(classes) ? classes : []).map(async (c: any) => {
        const group = String(c?.promotion || c?.name || '').trim();
        const students: any = (await SchoolService.getClassmates(token, c?.puid)) || [];
        return (Array.isArray(students) ? students : []).flatMap((s: any) => {
            const person = toPerson(s, false);
            return person ? [group ? { ...person, group } : person] : [];
        });
    }));
    return lists.flat();
}

// Années consultables (notes, absences, documents des années passées). MyGes les liste
// dans /me/years ; une valeur hors des dix dernières années est ignorée.
const YEARS_BACK = 10;

function yearOf(item: any): number {
    const candidates = item && typeof item === 'object' ? [item.year, item.annee, item.value, item.label, item.name] : [item];
    for (const value of candidates) {
        const year = parseInt(String(value ?? ''), 10); // « 2025-2026 » donne 2025
        if (Number.isInteger(year)) return year;
    }
    return NaN;
}

export function getYears(userId: string, token: GesAuthenticationToken): Promise<string[]> {
    return cached(userId, 'years', TTL_MS.profile, async () => {
        const current = Number(getCurrentYear());
        const years = new Set<number>([current]);
        let raw: any = null;
        try {
            raw = await ProfileService.getYears(token);
        } catch (e: any) {
            if (e?.status === 401) throw e; // token mort : la session doit tomber
        }
        let usable = false;
        for (const item of Array.isArray(raw) ? raw : []) {
            const year = yearOf(item);
            if (year <= current && year > current - YEARS_BACK) {
                years.add(year);
                usable = true;
            }
        }
        // Réponse inexploitable : on propose les dernières années ; une année vide le dira.
        if (!usable) for (let i = 1; i < RECENT_YEARS; i++) years.add(current - i);
        return [...years].sort((a, b) => b - a).map(String);
    });
}

export function getClassmates(userId: string, token: GesAuthenticationToken): Promise<DirectoryPerson[]> {
    return cached(userId, `classmates|${getCurrentYear()}`, TTL_MS.profile, async () => {
        // Les années d'inscription que donne MyGes (à défaut, les dernières), lues ensemble.
        const years = await getYears(userId, token);
        const results = await Promise.allSettled(years.map((year) => studentsOfYear(token, year)));
        const people = new Map<string, DirectoryPerson>();
        // Dans l'ordre des années, la plus récente d'abord : si quelqu'un revient d'une
        // année à l'autre, sa promotion actuelle l'emporte.
        for (const result of results) {
            if (result.status === 'rejected') {
                // Un token mort doit faire tomber la session ; une année indisponible
                // (jamais inscrit, erreur passagère) laisse simplement les autres s'afficher.
                if ((result.reason as any)?.status === 401) throw result.reason;
                continue;
            }
            for (const person of result.value) {
                if (!people.has(person.id)) people.set(person.id, person);
            }
        }
        return [...people.values()];
    });
}

export function getTeachers(userId: string, token: GesAuthenticationToken): Promise<DirectoryPerson[]> {
    const year = getCurrentYear();
    return cached(userId, `teachers|${year}`, TTL_MS.profile, async () => {
        const teachers: any = (await SchoolService.getTeachers(token, year)) || [];
        const people = (Array.isArray(teachers) ? teachers : []).map((t) => toPerson(t, true));
        return people.filter((person): person is DirectoryPerson => person !== null);
    });
}

/** Adresse de la photo de chaque camarade de classe. */
export async function getClassmatePhotos(userId: string, token: GesAuthenticationToken): Promise<Record<string, string>> {
    return photoMap(await getClassmates(userId, token));
}

/** Adresse de la photo de chaque intervenant. */
export async function getTeacherPhotos(userId: string, token: GesAuthenticationToken): Promise<Record<string, string>> {
    return photoMap(await getTeachers(userId, token));
}

/** Adresse de la photo d'un étudiant précis. L'appelant a vérifié qu'il partage un projet avec lui. */
export function getStudentPhoto(userId: string, token: GesAuthenticationToken, id: number): Promise<string | null> {
    return cached(userId, `student-photo|${id}`, TTL_MS.profile, async () => photoLink(await SchoolService.getStudent(token, id)));
}

export function getNews(userId: string, token: GesAuthenticationToken): Promise<any> {
    return cached(userId, 'news', TTL_MS.profile, async () => (await SchoolService.getNews(token)) ?? []);
}

/** Un brouillon n'existe pas encore pour les étudiants : ni annonce, ni rappel, ni affichage. */
const published = (items: any[] | null | undefined) => (items ?? []).filter((p) => !p?.is_draft);

export function getProjects(userId: string, token: GesAuthenticationToken): Promise<any[]> {
    const year = getCurrentYear();
    return cached(userId, `projects|${year}`, TTL_MS.projects, async () => published(await ProjectService.getProjects(token, year)));
}

function getPracticals(userId: string, token: GesAuthenticationToken): Promise<any[]> {
    const year = getCurrentYear();
    return cached(userId, `practicals|${year}`, TTL_MS.projects, async () => published(await ProjectService.getPracticals(token, year)));
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
