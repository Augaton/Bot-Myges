// Réponses de l'API du panel : seulement ce que l'écran affiche, jamais la réponse
// brute de MyGes. Tout est du texte : le navigateur l'insère sans l'interpréter.
import { courseName, coursePlace, formatCampus, fullName, getNextStep, snippet } from '../utils/format';
import { generalAverage, toSubject } from '../utils/grades';

// Très au-delà de ce qu'un étudiant peut avoir : une réponse démesurée n'occupe pas
// le serveur, dont le thread principal sert tout le monde.
const MAX_ROWS = 2_000;
const collator = new Intl.Collator('fr', { numeric: true });

const list = (raw: any): any[] => (Array.isArray(raw) ? raw.slice(0, MAX_ROWS) : []);

export function coursesView(raw: any) {
    const courses = [];
    for (const c of list(raw)) {
        const start = new Date(c?.start_date).getTime();
        const end = new Date(c?.end_date).getTime();
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
        const discipline = c?.discipline;
        courses.push({
            id: String(c?.reservation_id ?? start),
            name: courseName(c),
            start,
            end,
            place: coursePlace(c),
            teacher: String(c?.teacher ?? ''),
            type: String(c?.type ?? ''),
            modality: String(c?.modality ?? ''),
            comment: snippet(typeof c?.comment === 'string' ? c.comment : '', 500),
            rooms: list(c?.rooms).map((r) => ({ name: String(r?.name ?? ''), floor: String(r?.floor ?? ''), campus: formatCampus(String(r?.campus ?? '')) })),
            period: String(discipline?.trimester ?? ''),
            group: String(discipline?.student_group_name ?? ''),
            students: Number(discipline?.nb_students) || null,
            rcId: discipline?.rc_id == null ? '' : String(discipline.rc_id),
            signature: c?.is_electronic_signature === true,
        });
    }
    return courses.sort((a, b) => a.start - b.start);
}

export function notesView(raw: any) {
    const groups = new Map<string, any[]>();
    for (const row of list(raw)) {
        const name = String(row?.trimester_name ?? '');
        if (name) groups.set(name, [...(groups.get(name) ?? []), row]);
    }
    return [...groups.keys()].sort(collator.compare).map((name) => {
        const subjects = groups.get(name)!.map(toSubject).sort((a, b) => collator.compare(a.name, b.name));
        // Avant les moyennes définitives, le contrôle continu donne déjà une tendance.
        const provisional = generalAverage(subjects.map((s) => ({ ...s, average: s.average ?? s.ccAverage })));
        return { name, average: generalAverage(subjects), provisional, subjects };
    });
}

/** Absences de l'année, et assiduité par matière (`grades` : absences et retards de la dernière période). */
export function absencesView(raw: any, grades?: any) {
    const items = [];
    for (const a of list(raw)) {
        const date = new Date(a?.date).getTime();
        if (Number.isFinite(date)) items.push({ course: String(a?.course_name || 'Matière inconnue'), date, justified: !!a?.justified, period: String(a?.trimester_name ?? '') });
    }
    items.sort((a, b) => b.date - a.date);
    const subjects = (notesView(grades).at(-1)?.subjects ?? [])
        .map(({ name, absences, lates }) => ({ name, absences, lates }))
        .sort((a, b) => b.absences + b.lates - (a.absences + a.lates) || collator.compare(a.name, b.name));
    return {
        total: items.length,
        unjustified: items.filter((a) => !a.justified).length,
        lates: subjects.reduce((sum, subject) => sum + subject.lates, 0),
        items,
        subjects,
    };
}

/** Le groupe de l'étudiant dans ce projet, s'il en a un. */
function ownGroup(project: any, uid: number | null) {
    if (uid === null) return null;
    return list(project?.groups).find((g) => list(g?.project_group_students).some((s) => Number(s?.u_id) === uid)) ?? null;
}

/**
 * Étapes du projet, avec les seuls dépôts du groupe de l'étudiant : MyGes renvoie
 * à chacun les dépôts de TOUS les groupes, qui n'ont pas à être montrés.
 */
function projectSteps(project: any, group: any) {
    return list(project?.steps)
        .map((step) => ({
            id: String(step?.psp_id ?? ''),
            type: String(step?.psp_type || 'Étape'),
            desc: snippet(step?.psp_desc, 1_000),
            date: Number(step?.psp_limit_date),
            files: group
                ? list(step?.files)
                    .filter((f) => Number(f?.pgr_id) === Number(group.project_group_id) && f?.psf_id != null)
                    .map((f) => ({
                        id: String(f.psf_id),
                        title: snippet(String(f?.psf_name || f?.psf_desc || ''), 160) || 'Dépôt',
                        fileName: String(f?.psf_name || 'depot') + String(f?.psf_file_type ?? ''),
                        date: Number(f?.psf_end_upload) || null,
                    }))
                : [],
        }))
        .filter((step) => Number.isFinite(step.date))
        .sort((a, b) => a.date - b.date);
}

/** Tous les projets et TP : à venir d'abord, par échéance, puis les terminés. */
export function projectsView(raw: any, uid: number | null = null) {
    const now = Date.now();
    const items = [];
    for (const p of list(raw)) {
        if (p?.project_id == null || p?.is_draft) continue;
        const group = ownGroup(p, uid);
        const steps = projectSteps(p, group);
        const next = getNextStep(p);
        items.push({
            id: String(p.project_id),
            name: String(p?.name || 'Projet'),
            course: String(p?.course_name ?? ''),
            practical: !!p?.practical,
            type: next ? String(next.type) : '',
            date: next ? Number(next.date) : null,
            last: steps.at(-1)?.date ?? 0,
            stepsDone: steps.filter((s) => s.date <= now).length,
            stepsTotal: steps.length,
            group: group ? String(group?.group_name ?? '') : null,
        });
    }
    return items.sort((a, b) => (a.date ?? Infinity) - (b.date ?? Infinity) || b.last - a.last);
}

/** Les équipes du projet : noms et effectifs seulement, pour choisir la sienne. */
function teamsOf(project: any, mine: any) {
    const max = Number(project?.project_max_student_group) || null;
    return list(project?.groups)
        .filter((g) => g?.project_group_id != null)
        .map((g) => {
            const members = list(g?.project_group_students).map((s) => fullName({ firstname: s?.firstname, lastname: s?.name }));
            return { id: String(g.project_group_id), name: String(g?.group_name ?? ''), members, mine: g === mine, full: max !== null && members.length >= max };
        })
        .sort((a, b) => Number(b.mine) - Number(a.mine) || collator.compare(a.name, b.name));
}

/**
 * Page d'un projet, ou null s'il n'est pas dans ceux de l'étudiant. Des autres équipes,
 * seuls les noms et les membres y figurent : ni dépôts, ni commentaires, ni journal.
 * `teacher_intern_comment` reste hors de la réponse : il n'est pas destiné aux
 * étudiants, même si l'API le transmet.
 */
export function projectDetail(raw: any, id: string, uid: number | null) {
    const p = list(raw).find((x) => String(x?.project_id) === id && !x?.is_draft);
    if (!p) return null;
    const group = ownGroup(p, uid);
    const groupId = group ? Number(group.project_group_id) : null;
    // Changer d'équipe n'a de sens qu'en choix libre, tant que le projet est en cours.
    const changeable = !!getNextStep(p) && /libre/i.test(String(p?.project_type_group ?? ''));
    return {
        id,
        rcId: p?.rc_id == null ? '' : String(p.rc_id),
        canJoin: changeable && !group,
        canLeave: changeable && !!group,
        teams: teamsOf(p, group),
        name: String(p?.name || 'Projet'),
        course: String(p?.course_name ?? ''),
        practical: !!p?.practical,
        teacher: String(p?.author ?? ''),
        goal: snippet(p?.project_teaching_goals, 2_000),
        plan: snippet(p?.project_detail_plan, 4_000),
        tools: snippet(p?.project_computing_tools, 500),
        books: snippet(p?.project_ref_books, 1_000),
        subjectType: String(p?.project_type_subject ?? ''),
        groupType: String(p?.project_type_group ?? ''),
        groupSize: { min: Number(p?.project_min_student_group) || null, max: Number(p?.project_max_student_group) || null },
        groupCount: list(p?.groups).length,
        updated: Number(p?.update_date) || null,
        steps: projectSteps(p, group),
        files: list(p?.project_files)
            .filter((f) => f?.pf_id != null)
            .map((f) => ({
                id: String(f.pf_id),
                title: snippet(String(f?.pf_title || f?.pf_file || ''), 160) || 'Document',
                fileName: String(f?.pf_file || f?.pf_title || 'document'),
                date: Number(f?.pf_crea_date) || null,
            })),
        group: group && {
            name: String(group?.group_name ?? ''),
            subjectValidated: !!group?.subject_validated,
            presentation: Number(group?.date_presentation) || null,
            teacherComment: snippet(group?.teacher_comment, 2_000),
            members: list(group?.project_group_students).map((s) => fullName({ firstname: s?.firstname, lastname: s?.name })),
        },
        activity: list(p?.project_group_logs)
            .filter((l) => groupId !== null && Number(l?.pgr_id) === groupId)
            .map((l) => ({ date: Number(l?.pgl_date) || null, author: String(l?.pgl_author ?? ''), text: snippet(l?.pgl_describe, 300) }))
            .sort((a, b) => (b.date ?? 0) - (a.date ?? 0))
            .slice(0, 30),
    };
}

/** Événements à venir, du plus proche au plus lointain. */
export function eventsView(raw: any) {
    const now = Date.now();
    return list(raw)
        .map((e) => ({
            title: snippet(String(e?.event_title || 'Événement'), 160),
            date: Number(e?.event_date),
            type: String(e?.event_type ?? ''),
            location: snippet(String(e?.location ?? ''), 160),
            organizer: snippet(String(e?.organizer ?? ''), 160),
            description: snippet(String(e?.description ?? ''), 2_000),
        }))
        .filter((e) => Number.isFinite(e.date) && e.date >= now)
        .sort((a, b) => a.date - b.date);
}

/** Ce que le syllabus apporte à l'étudiant, en texte brut. Null si la matière n'en a pas. */
export function syllabusView(raw: any) {
    const s = Array.isArray(raw) ? raw[0] : raw;
    if (!s || typeof s !== 'object') return null;
    const text = (value: unknown, max = 1_000) => snippet(typeof value === 'string' ? value : '', max);
    return {
        ects: Number(s.ects) || null,
        coef: Number(s.coef) || null,
        evaluation: list(s.control_types).map((c) => String(c?.evaluation_label ?? '')).filter(Boolean),
        prerequisite: text(s.prerequisite),
        criteria: text(s.evaluation_criteria),
        plan: text(s.detail_plan, 4_000),
        sessions: list(s.seance_details).map((d) => snippet(typeof d?.content === 'string' ? d.content : '', 300)).filter(Boolean),
    };
}

export function newsView(raw: any) {
    return list(raw?.content ?? raw).map((n) => {
        const date = new Date(n?.date).getTime();
        return {
            title: snippet(n?.title || n?.subject || 'Sans titre', 160),
            body: snippet(n?.summary || n?.html || n?.content || n?.message || n?.body || n?.description || '', 4_000),
            date: Number.isFinite(date) ? date : null,
        };
    });
}
