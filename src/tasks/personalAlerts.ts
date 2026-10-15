// --- ALERTES PERSONNELLES EN MP ---
// Pour chaque utilisateur connecté (réglable via /alertes) :
//  • un MP dès qu'une nouvelle note apparaît sur MyGes ;
//  • un MP la veille (24 h avant) et 2 h avant chaque échéance de projet ;
//  • un MP quand un cours de la semaine à venir est annulé, déplacé, ajouté ou
//    change de salle ;
//  • sur demande, un MP chaque matin avec les cours du jour.
import { Client, EmbedBuilder, escapeMarkdown } from 'discord.js';
import { getGrades, getProjects, getTimetable } from '../core/mygesData';
import { getSession, getUserAlerts, loadData, saveData, UserAlerts } from '../core/store';
import { getCurrentYear } from '../config';
import { decrypt, encrypt, fingerprint } from '../crypto';
import { sendDM } from '../utils/dm';
import { courseName, coursePlace, getCourseIcon, snippet } from '../utils/format';
import { log, logError } from '../utils/logger';
import { toSubject } from '../utils/notesImage';
import type { GesAuthenticationToken } from '../myges/types/auth';

// Cycle court pour tenir l'heure des rappels « 2 h avant » ; notes, projets et
// agenda ne sont pour autant relus auprès de MyGes qu'une fois par heure et par personne.
export const PERSONAL_CHECK_INTERVAL = 15 * 60 * 1000;
const REFRESH_MS = 60 * 60 * 1000;
// Pause entre deux utilisateurs interrogeant MyGes : on reste discret.
const PAUSE_BETWEEN_USERS_MS = 2_000;

const HOUR = 60 * 60 * 1000;
export const REMINDER_THRESHOLDS = [
    { ms: 24 * HOUR, title: '📅 Rendu demain', color: 0xe67e22 },
    { ms: 2 * HOUR, title: '⏰ Rendu dans 2 h !', color: 0xe74c3c },
];

const FOOTER = { text: 'Désactiver ces MP : /alertes' };

// Dernières lectures MyGes, en mémoire (un redémarrage relit simplement tout).
// Rattachées à l'objet d'identifiants de l'utilisateur : un /logout ou un
// nouveau /login le remplace, on repart donc de zéro (pas de rappels tirés des
// projets d'un autre compte) et l'ancienne entrée est libérée d'elle-même.
interface Memo {
    gradesAt: number;
    agendaAt: number;
    projects?: { at: number; list: any[] };
}
const memos = new WeakMap<object, Memo>();

/** Ce dont chaque vérification a besoin pour un utilisateur. */
interface UserCheck {
    client: Client;
    userId: string;
    alerts: UserAlerts;
    memo: Memo;
    /**
     * Faux si l'utilisateur s'est déconnecté ou reconnecté (peut-être à un autre
     * compte MyGes) pendant un appel : ce qui vient d'être lu ne le concerne
     * plus et ne doit rien modifier.
     */
    current: () => boolean;
}

// ---------------------------------------------------------------- Notes

// Format des identifiants de notes. En changer rend méconnaissables toutes les
// empreintes déjà mémorisées : elles sont alors réamorcées sans MP.
// 1 : position dans la liste. 2 : rang parmi les notes de même valeur.
const GRADE_ID_FORMAT = 2;

export interface GradeEvent {
    id: string; // identifiant stable de la note (jamais stocké en clair)
    course: string;
    trimester: string;
    kind: 'cc' | 'exam' | 'average';
    value: number;
}

/** Toutes les notes visibles, sous forme d'évènements comparables d'un cycle à l'autre. */
export function gradeEvents(raw: any[]): GradeEvent[] {
    const events: GradeEvent[] = [];
    for (const r of raw) {
        const s = toSubject(r);
        const trimester = String(r?.trimester_name ?? '');
        const base = `${trimester}|${s.name}`;
        // Une note se reconnaît à sa valeur et à son rang parmi les notes égales,
        // pas à sa position : une note retirée ou insérée en milieu de liste ne
        // fait plus passer toutes les suivantes pour des nouvelles.
        const rank = new Map<number, number>();
        for (const value of s.notes) {
            const n = (rank.get(value) ?? 0) + 1;
            rank.set(value, n);
            events.push({ id: `${base}|cc|${value}|${n}`, course: s.name, trimester, kind: 'cc', value });
        }
        // 0 en examen ou en moyenne signifie le plus souvent « pas encore noté ».
        if (s.exam) events.push({ id: `${base}|exam|${s.exam}`, course: s.name, trimester, kind: 'exam', value: s.exam });
        if (s.average) events.push({ id: `${base}|average|${s.average}`, course: s.name, trimester, kind: 'average', value: s.average });
    }
    return events;
}

const fmtGrade = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0$/, '')).replace('.', ',');
const KIND_LABEL = { cc: 'Note', exam: 'Examen', average: 'Moyenne de la matière' } as const;

function gradesEmbed(events: GradeEvent[]): EmbedBuilder {
    const byCourse = new Map<string, GradeEvent[]>();
    for (const e of events) {
        const key = `${e.course}|${e.trimester}`;
        byCourse.set(key, [...(byCourse.get(key) ?? []), e]);
    }
    const embed = new EmbedBuilder()
        .setTitle(events.length > 1 ? `📝 ${events.length} nouvelles notes !` : '📝 Nouvelle note !')
        .setColor(0x23a55a)
        .setFooter({ text: `Détail avec /notes · ${FOOTER.text}` })
        .setTimestamp();
    for (const list of [...byCourse.values()].slice(0, 25)) {
        const { course, trimester } = list[0];
        embed.addFields({
            name: `📘 ${course}${trimester ? ` · ${trimester}` : ''}`.slice(0, 256),
            value: list.map((e) => `• ${KIND_LABEL[e.kind]} : **${fmtGrade(e.value)}**/20`).join('\n').slice(0, 1024),
        });
    }
    return embed;
}

/** Compare les notes à celles déjà vues ; envoie un MP s'il y en a de nouvelles. Vrai si l'état a changé. */
async function checkGrades({ client, userId, alerts, current }: UserCheck, token: GesAuthenticationToken): Promise<boolean> {
    const year = getCurrentYear();
    const raw = await getGrades(userId, token);
    if (!Array.isArray(raw) || !current()) return false;
    const keyed = gradeEvents(raw).map((event) => ({ event, key: fingerprint(event.id) }));

    // Premier passage, nouvelle année scolaire ou nouveau format d'identifiants :
    // on mémorise sans alerter, sinon tout l'historique arriverait d'un coup.
    if (alerts.gradesYear !== year || !alerts.knownGrades || alerts.gradeIdFormat !== GRADE_ID_FORMAT) {
        alerts.gradesYear = year;
        alerts.gradeIdFormat = GRADE_ID_FORMAT;
        alerts.knownGrades = keyed.map((k) => k.key);
        return true;
    }

    const known = new Set(alerts.knownGrades);
    const fresh = keyed.filter((k) => !known.has(k.key));
    if (!fresh.length) return false;

    // On ajoute sans jamais retirer : une note qui disparaît un instant (aléa
    // de l'API) puis réapparaît n'est pas annoncée une seconde fois.
    alerts.knownGrades = [...known, ...new Set(fresh.map((k) => k.key))];
    await sendDM(client, userId, { embeds: [gradesEmbed(fresh.map((k) => k.event))] });
    log('ALERTES', `${userId} : ${fresh.length} nouvelle(s) note(s) signalée(s) en MP.`);
    return true;
}

// ---------------------------------------------------------------- Rappels

export interface Deadline {
    key: string;
    at: number;
    project: string;
    course: string;
    type: string;
    desc: string;
}

/** Échéances à venir de tous les projets (étapes, ou fin de projet à défaut). */
export function upcomingDeadlines(projects: any[], now: number): Deadline[] {
    const out: Deadline[] = [];
    for (const p of projects) {
        const project = String(p?.name || 'Projet');
        const course = String(p?.course_name || '');
        const steps: any[] = Array.isArray(p?.steps) && p.steps.length
            ? p.steps
            : [{ psp_limit_date: p?.end_date, psp_type: 'Rendu final', psp_id: 'fin' }];
        for (const s of steps) {
            const at = Number(s?.psp_limit_date);
            if (!Number.isFinite(at) || at <= now) continue;
            out.push({
                key: `${p?.project_id}|${s?.psp_id ?? s?.psp_number ?? at}`,
                at,
                project,
                course,
                type: String(s?.psp_type || 'Étape'),
                desc: snippet(s?.psp_desc || '', 200),
            });
        }
    }
    return out;
}

/**
 * Rappels à envoyer maintenant. Pour chaque échéance, seul le seuil atteint le
 * plus proche compte : un bot redémarré 1 h avant un rendu envoie le rappel
 * « 2 h », pas aussi celui de la veille.
 */
export function dueReminders(deadlines: Deadline[], now: number, reminded: Record<string, number>) {
    const out: { id: string; deadline: Deadline; threshold: (typeof REMINDER_THRESHOLDS)[number] }[] = [];
    for (const deadline of deadlines) {
        const reached = REMINDER_THRESHOLDS.filter((t) => now >= deadline.at - t.ms);
        if (!reached.length) continue;
        const threshold = reached.reduce((a, b) => (b.ms < a.ms ? b : a));
        const id = `${deadline.key}|${threshold.ms}`;
        if (!reminded[id]) out.push({ id, deadline, threshold });
    }
    return out;
}

function reminderEmbed(d: Deadline, threshold: (typeof REMINDER_THRESHOLDS)[number]): EmbedBuilder {
    const ts = Math.floor(d.at / 1000);
    const embed = new EmbedBuilder()
        .setTitle(threshold.title)
        .setDescription(`**${d.project}**${d.course ? `\n📚 ${d.course}` : ''}`.slice(0, 4096))
        .setColor(threshold.color)
        .addFields(
            { name: '🎯 Étape', value: d.type.slice(0, 1024), inline: true },
            { name: '🗓️ Échéance', value: `<t:${ts}:F> (<t:${ts}:R>)`, inline: true },
        )
        .setFooter(FOOTER);
    if (d.desc) embed.addFields({ name: '📝 Consigne', value: d.desc.slice(0, 1024) });
    return embed;
}

/** Envoie les rappels arrivés à échéance. Vrai si l'état a changé. */
async function checkReminders({ client, userId, alerts, memo, current }: UserCheck, token: GesAuthenticationToken | null): Promise<boolean> {
    const now = Date.now();
    if (!memo.projects || now - memo.projects.at >= REFRESH_MS) {
        if (!token) return false;
        memo.projects = { at: now, list: await getProjects(userId, token) };
    }
    if (!current()) return false;

    let changed = false;
    alerts.reminded ??= {};
    for (const [id, at] of Object.entries(alerts.reminded)) {
        if (at < now) {
            delete alerts.reminded[id];
            changed = true;
        }
    }

    const due = dueReminders(upcomingDeadlines(memo.projects.list, now), now, alerts.reminded);
    if (!due.length) return changed;

    // Marqués avant l'envoi : des MP fermés ne doivent pas provoquer une
    // nouvelle tentative (et un nouveau log) tous les quarts d'heure.
    for (const r of due) alerts.reminded[r.id] = r.deadline.at;
    // Un MP accepte jusqu'à 10 embeds.
    for (let i = 0; i < due.length; i += 10) {
        await sendDM(client, userId, { embeds: due.slice(i, i + 10).map((r) => reminderEmbed(r.deadline, r.threshold)) });
    }
    log('ALERTES', `${userId} : ${due.length} rappel(s) de rendu envoyé(s) en MP.`);
    return true;
}

// ---------------------------------------------------------------- Agenda

// Heure (Paris) à partir de laquelle part le programme du jour.
const DIGEST_HOUR = 7;

/** Ce qu'on retient d'un cours pour repérer un changement. */
export interface SeenCourse {
    name: string;
    start: number;
    end: number;
    place: string;
}

/** Cours à venir lors d'une lecture, et fin de la période qu'elle couvrait. */
export interface AgendaSnapshot {
    until: number;
    courses: Record<string, SeenCourse>;
}

export interface AgendaChange {
    kind: 'cancelled' | 'moved' | 'room' | 'added';
    before?: SeenCourse;
    after?: SeenCourse;
}

/** Minuit (heure de Paris) du jour de `now`, décalé de `days` jours. */
function midnight(now: number, days = 0): number {
    const d = new Date(now);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime();
}

/** Jour de `now` au format AAAA-MM-JJ (heure de Paris). */
function dayKey(now: number): string {
    const d = new Date(now);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Compare l'agenda lu (couvrant au moins jusqu'à `until`) à la lecture
 * précédente. Sans lecture précédente, mémorise sans rien signaler.
 */
export function agendaChanges(courses: any[], previous: AgendaSnapshot | null, now: number, until: number) {
    const current = new Map<string, SeenCourse>();
    for (const c of courses) {
        const start = Number(c?.start_date);
        const end = Number(c?.end_date);
        if (c?.reservation_id == null || !Number.isFinite(start) || !Number.isFinite(end)) continue;
        current.set(String(c.reservation_id), { name: courseName(c), start, end, place: coursePlace(c) });
    }

    // Réponse vide alors que des cours étaient attendus : bien plus souvent un
    // raté de MyGes qu'une semaine entière annulée. On n'annonce rien et on
    // garde la lecture précédente.
    if (!current.size && previous && Object.values(previous.courses).some((c) => c.start > now)) {
        return { changes: [] as AgendaChange[], next: previous };
    }

    const next: AgendaSnapshot = { until, courses: {} };
    for (const [id, course] of current) {
        if (course.start > now && course.start <= until) next.courses[id] = course;
    }
    if (!previous) return { changes: [] as AgendaChange[], next };

    const changes: AgendaChange[] = [];
    for (const [id, before] of Object.entries(previous.courses)) {
        if (before.start <= now) continue; // commencé ou passé : plus rien à signaler
        const after = current.get(id);
        if (!after) changes.push({ kind: 'cancelled', before });
        else if (after.start !== before.start || after.end !== before.end) changes.push({ kind: 'moved', before, after });
        // Une salle attribuée après coup n'est pas un changement.
        else if (before.place && after.place !== before.place) changes.push({ kind: 'room', before, after });
    }
    for (const [id, after] of current) {
        // Seuls comptent les ajouts dans la période déjà couverte : les cours qui
        // y entrent au fil des jours ne sont pas « nouveaux ».
        if (!previous.courses[id] && after.start > now && after.start <= previous.until) changes.push({ kind: 'added', after });
    }
    changes.sort((a, b) => (a.after ?? a.before)!.start - (b.after ?? b.before)!.start);
    return { changes, next };
}

const slot = (c: SeenCourse) => `<t:${Math.floor(c.start / 1000)}:F> – <t:${Math.floor(c.end / 1000)}:t>`;

// Noms de cours et de salles viennent de MyGes : échappés pour qu'un « * », un
// « ~ » ou un lien masqué ne détourne pas la mise en forme du MP.
const md = (text: string) => escapeMarkdown(text, { maskedLink: true, heading: true });

function agendaField(change: AgendaChange): { name: string; value: string } {
    const { before, after } = change;
    const name = md((after ?? before)!.name);
    switch (change.kind) {
        case 'cancelled':
            return { name: `❌ Cours annulé · ${name}`, value: `Prévu ${slot(before!)}\nIl n'apparaît plus dans ton agenda.` };
        case 'moved':
            return { name: `🔀 Cours déplacé · ${name}`, value: `~~${slot(before!)}~~\n➜ **${slot(after!)}**` };
        case 'room':
            return { name: `📍 Changement de salle · ${name}`, value: `${slot(after!)}\n~~${md(before!.place)}~~ ➜ **${md(after!.place) || 'non définie'}**` };
        case 'added':
            return { name: `➕ Nouveau cours · ${name}`, value: `${slot(after!)}${after!.place ? `\n📍 ${md(after!.place)}` : ''}` };
    }
}

function agendaEmbed(changes: AgendaChange[]): EmbedBuilder {
    return new EmbedBuilder()
        .setTitle(changes.length > 1 ? `🗓️ ${changes.length} changements dans ton agenda` : '🗓️ Changement dans ton agenda')
        .setColor(0xf1c40f)
        .addFields(changes.slice(0, 25).map(agendaField).map((f) => ({ name: f.name.slice(0, 256), value: f.value.slice(0, 1024) })))
        .setFooter({ text: `Détail avec /agenda · ${FOOTER.text}` })
        .setTimestamp();
}

function digestEmbed(courses: any[]): EmbedBuilder {
    const lines = courses.map((c) => {
        const name = courseName(c);
        const place = coursePlace(c);
        const time = `<t:${Math.floor(Number(c.start_date) / 1000)}:t> – <t:${Math.floor(Number(c.end_date) / 1000)}:t>`;
        return `${getCourseIcon(name, String(c?.modality ?? ''))} **${time}** · ${md(name)}${place ? `\n📍 ${md(place)}` : ''}`;
    });
    return new EmbedBuilder()
        .setTitle('☀️ Ton programme du jour')
        .setDescription(lines.join('\n\n').slice(0, 4096))
        .setColor(0xf39c12)
        .setFooter({ text: `Semaine complète avec /agenda · ${FOOTER.text}` })
        .setTimestamp();
}

/** Le programme du matin est-il à envoyer maintenant ? */
function digestDue(alerts: UserAlerts, now: number): boolean {
    return alerts.digest && new Date(now).getHours() >= DIGEST_HOUR && alerts.digestSentOn !== dayKey(now);
}

function readSnapshot(alerts: UserAlerts): AgendaSnapshot | null {
    if (!alerts.agendaSnapshot) return null;
    try {
        return JSON.parse(decrypt(alerts.agendaSnapshot));
    } catch {
        return null; // illisible : on repart d'une lecture neuve, sans alerter
    }
}

/**
 * Vrai si `next` n'apporte rien de neuf par rapport à `previous`. Les cours
 * commencés entre-temps n'y comptent pas (agendaChanges les ignore) : sans
 * cela, chaque début de cours ferait rechiffrer et réécrire tout le fichier.
 */
function sameSnapshot(next: AgendaSnapshot, previous: AgendaSnapshot | null, now: number): boolean {
    if (next === previous) return true;
    if (!previous || next.until !== previous.until) return false;
    const upcoming = Object.entries(previous.courses).filter(([, c]) => c.start > now);
    return JSON.stringify(Object.fromEntries(upcoming)) === JSON.stringify(next.courses);
}

/** Signale les changements d'agenda et envoie le programme du jour. Vrai si l'état a changé. */
async function checkAgenda({ client, userId, alerts, memo, current }: UserCheck, token: GesAuthenticationToken): Promise<boolean> {
    const now = Date.now();
    // Bornes calées sur minuit : stables toute la journée, ce qui évite de
    // réécrire la lecture mémorisée à chaque passage.
    const until = midnight(now, 8);
    const courses = await getTimetable(userId, token, new Date(midnight(now)), new Date(until));
    memo.agendaAt = now;
    if (!current()) return false;

    // Tout l'état est mis à jour avant le premier envoi : rien ne doit plus le
    // modifier une fois qu'on attend Discord.
    let changed = false;
    let changes: AgendaChange[] = [];
    if (alerts.agenda) {
        const previous = readSnapshot(alerts);
        const result = agendaChanges(courses, previous, now, until);
        changes = result.changes;
        if (!sameSnapshot(result.next, previous, now)) {
            alerts.agendaSnapshot = encrypt(JSON.stringify(result.next));
            changed = true;
        }
    }
    let today: any[] = [];
    if (digestDue(alerts, now)) {
        // Marqué même sans cours : on ne relit pas l'agenda tous les quarts d'heure.
        alerts.digestSentOn = dayKey(now);
        changed = true;
        const tomorrow = midnight(now, 1);
        today = courses
            .filter((c) => Number(c?.end_date) > now && Number(c?.start_date) < tomorrow)
            .sort((a, b) => Number(a.start_date) - Number(b.start_date));
    }

    if (changes.length) {
        await sendDM(client, userId, { embeds: [agendaEmbed(changes)] });
        log('ALERTES', `${userId} : ${changes.length} changement(s) d'agenda signalé(s) en MP.`);
    }
    if (today.length) {
        await sendDM(client, userId, { embeds: [digestEmbed(today)] });
        log('ALERTES', `${userId} : programme du jour envoyé en MP (${today.length} cours).`);
    }
    return changed;
}

// ---------------------------------------------------------------- Cycle

let running = false;

/** Point d'entrée : n'exécute jamais deux cycles en parallèle. */
export async function runPersonalCheck(client: Client) {
    if (running) return;
    running = true;
    try {
        await checkAllUsers(client);
    } catch (e) {
        logError('ALERTES', 'Cycle des alertes personnelles en échec :', e);
    } finally {
        running = false;
    }
}

async function checkAllUsers(client: Client) {
    const data = loadData();
    let pause = false;

    for (const userId of Object.keys(data.users)) {
        const creds = data.users[userId];
        if (!creds) continue; // déconnecté pendant le cycle
        let memo = memos.get(creds);
        if (!memo) memos.set(creds, (memo = { gradesAt: 0, agendaAt: 0 }));

        const alerts = getUserAlerts(data, userId);
        const now = Date.now();
        const wantsGrades = alerts.grades && now - memo.gradesAt >= REFRESH_MS;
        const projectsStale = now - (memo.projects?.at ?? 0) >= REFRESH_MS;
        const wantsAgenda = (alerts.agenda && now - memo.agendaAt >= REFRESH_MS) || digestDue(alerts, now);
        if (!wantsGrades && !alerts.reminders && !wantsAgenda) continue;

        // Une session (et donc un appel MyGes) n'est nécessaire que pour relire
        // notes, projets ou agenda ; sinon, les rappels se calculent sur la dernière lecture.
        let token: GesAuthenticationToken | null = null;
        if (wantsGrades || wantsAgenda || (alerts.reminders && projectsStale)) {
            if (pause) await new Promise((r) => setTimeout(r, PAUSE_BETWEEN_USERS_MS));
            pause = true;
            token = await getSession(userId);
            if (!token) continue; // pas de session (MyGes en panne, mot de passe changé…)
        }

        const check: UserCheck = { client, userId, alerts, memo, current: () => data.users[userId] === creds };
        let changed = false;
        if (wantsGrades && token) {
            try {
                changed = (await checkGrades(check, token)) || changed;
                memo.gradesAt = Date.now();
            } catch (e) {
                logError('ALERTES', `${userId} : vérification des notes impossible :`, e);
            }
        }
        if (alerts.reminders) {
            try {
                changed = (await checkReminders(check, token)) || changed;
            } catch (e) {
                logError('ALERTES', `${userId} : vérification des rendus impossible :`, e);
            }
        }
        if (wantsAgenda && token) {
            try {
                changed = (await checkAgenda(check, token)) || changed;
            } catch (e) {
                logError('ALERTES', `${userId} : vérification de l'agenda impossible :`, e);
            }
        }
        if (changed && check.current()) saveData(data);
    }
}
