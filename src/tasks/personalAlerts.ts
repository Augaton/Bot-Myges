// --- ALERTES PERSONNELLES EN MP ---
// Pour chaque utilisateur connecté (réglable via /alertes) :
//  • un MP dès qu'une nouvelle note apparaît sur MyGes ;
//  • un MP la veille (24 h avant) et 2 h avant chaque échéance de projet.
import { Client, EmbedBuilder } from 'discord.js';
import { getGrades, getProjects } from '../core/mygesData';
import { getSession, getUserAlerts, loadData, saveData, UserAlerts } from '../core/store';
import { getCurrentYear } from '../config';
import { fingerprint } from '../crypto';
import { sendDM } from '../utils/dm';
import { snippet } from '../utils/format';
import { log, logError } from '../utils/logger';
import { toSubject } from '../utils/notesImage';
import type { GesAuthenticationToken } from '../myges/types/auth';

// Cycle court pour tenir l'heure des rappels « 2 h avant » ; notes et projets
// ne sont pour autant relus auprès de MyGes qu'une fois par heure et par personne.
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

// Dernières lectures MyGes (en mémoire : un redémarrage relit simplement tout).
const lastGradesCheck = new Map<string, number>();
const projectSnapshots = new Map<string, { at: number; projects: any[] }>();

// ---------------------------------------------------------------- Notes

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
        s.notes.forEach((value, i) => {
            events.push({ id: `${base}|cc|${i}|${value}`, course: s.name, trimester, kind: 'cc', value });
        });
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
async function checkGrades(client: Client, userId: string, token: GesAuthenticationToken, alerts: UserAlerts): Promise<boolean> {
    const year = getCurrentYear();
    const raw = await getGrades(userId, token);
    if (!Array.isArray(raw)) return false;
    const keyed = gradeEvents(raw).map((event) => ({ event, key: fingerprint(event.id) }));

    // Premier passage (ou nouvelle année scolaire) : on mémorise sans alerter,
    // sinon tout l'historique arriverait d'un coup.
    if (alerts.gradesYear !== year || !alerts.knownGrades) {
        alerts.gradesYear = year;
        alerts.knownGrades = keyed.map((k) => k.key);
        return true;
    }

    const known = new Set(alerts.knownGrades);
    const fresh = keyed.filter((k) => !known.has(k.key));
    if (!fresh.length) return false;

    // On ajoute sans jamais retirer : une note qui disparaît un instant (aléa
    // de l'API) puis réapparaît n'est pas annoncée une seconde fois.
    alerts.knownGrades = [...known, ...new Set(fresh.map((k) => k.key))];
    if (!loadData().users[userId]) return true; // déconnecté entre-temps
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
async function checkReminders(client: Client, userId: string, token: GesAuthenticationToken | null, alerts: UserAlerts): Promise<boolean> {
    const now = Date.now();
    let snapshot = projectSnapshots.get(userId);
    if (!snapshot || now - snapshot.at >= REFRESH_MS) {
        if (!token) return false;
        snapshot = { at: now, projects: await getProjects(userId, token) };
        projectSnapshots.set(userId, snapshot);
    }

    let changed = false;
    alerts.reminded ??= {};
    for (const [id, at] of Object.entries(alerts.reminded)) {
        if (at < now) {
            delete alerts.reminded[id];
            changed = true;
        }
    }

    const due = dueReminders(upcomingDeadlines(snapshot.projects, now), now, alerts.reminded);
    if (!due.length) return changed;

    // Marqués avant l'envoi : des MP fermés ne doivent pas provoquer une
    // nouvelle tentative (et un nouveau log) tous les quarts d'heure.
    for (const r of due) alerts.reminded[r.id] = r.deadline.at;
    if (!loadData().users[userId]) return true; // déconnecté entre-temps
    // Un MP accepte jusqu'à 10 embeds.
    for (let i = 0; i < due.length; i += 10) {
        await sendDM(client, userId, { embeds: due.slice(i, i + 10).map((r) => reminderEmbed(r.deadline, r.threshold)) });
    }
    log('ALERTES', `${userId} : ${due.length} rappel(s) de rendu envoyé(s) en MP.`);
    return true;
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
        if (!data.users[userId]) continue; // déconnecté pendant le cycle
        const alerts = getUserAlerts(data, userId);
        const now = Date.now();
        const wantsGrades = alerts.grades && now - (lastGradesCheck.get(userId) ?? 0) >= REFRESH_MS;
        const projectsStale = now - (projectSnapshots.get(userId)?.at ?? 0) >= REFRESH_MS;
        if (!wantsGrades && !alerts.reminders) continue;

        // Une session (et donc un appel MyGes) n'est nécessaire que pour relire
        // notes ou projets ; sinon, les rappels se calculent sur la dernière lecture.
        let token: GesAuthenticationToken | null = null;
        if (wantsGrades || (alerts.reminders && projectsStale)) {
            if (pause) await new Promise((r) => setTimeout(r, PAUSE_BETWEEN_USERS_MS));
            pause = true;
            token = await getSession(userId);
            if (!token) continue; // pas de session (MyGes en panne, mot de passe changé…)
        }

        let changed = false;
        if (wantsGrades && token) {
            try {
                changed = (await checkGrades(client, userId, token, alerts)) || changed;
                lastGradesCheck.set(userId, Date.now());
            } catch (e) {
                logError('ALERTES', `${userId} : vérification des notes impossible :`, e);
            }
        }
        if (alerts.reminders) {
            try {
                changed = (await checkReminders(client, userId, token, alerts)) || changed;
            } catch (e) {
                logError('ALERTES', `${userId} : vérification des rendus impossible :`, e);
            }
        }
        if (changed && data.users[userId]) saveData(data);
    }
}
