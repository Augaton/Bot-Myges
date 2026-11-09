// Notes MyGes : normalisation et moyennes, sans dépendance au rendu.

export interface Subject {
    name: string;
    teacher: string;
    average: number | null; // moyenne définitive
    ccAverage: number | null; // moyenne de contrôle continu
    notes: number[]; // notes de contrôle continu
    exam: number | null;
    absences: number;
    ects: number | null;
    coef: number | null;
    lates: number;
    letter: string; // mention en lettre (A, B…), vide si MyGes n'en donne pas
    rcId: string; // identifiant de la matière, pour ses supports et son syllabus
}

// Nombre exploitable, ou null (l'API renvoie indifféremment null, '', 0 ou une chaîne).
function num(v: any): number | null {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
}

// Normalise une note MyGes vers notre structure interne.
export function toSubject(raw: any): Subject {
    // Nettoyage du nom (ex: "T1 - anglais" -> "anglais")
    const name = String(raw?.course || 'Matière inconnue').replace(/^T\d+\s*-\s*/i, '').trim();
    const first = raw?.teacher_first_name ? `${raw.teacher_first_name} ` : '';
    const teacher = raw?.teacher_last_name ? `${first}${raw.teacher_last_name}` : '';

    // Les notes de CC arrivent en nombres bruts, parfois en objets selon l'année.
    const notes: number[] = Array.isArray(raw?.grades)
        ? raw.grades.map((g: any) => num(typeof g === 'object' && g ? g.grade ?? g.value : g)).filter((v: number | null): v is number => v !== null)
        : [];

    const cc = num(raw?.ccaverage);
    const average = num(raw?.average);
    const exam = num(raw?.exam);
    return {
        name,
        teacher,
        // MyGes met 0 tant qu'une matière n'est pas notée : ce n'est pas un 0/20.
        average: average === 0 && !notes.length && !exam ? null : average,
        // Une moyenne CC à 0 signifie « pas encore de note » côté MyGes.
        ccAverage: cc && cc > 0 ? cc : null,
        notes,
        exam,
        absences: num(raw?.absences) ?? 0,
        ects: num(raw?.ects),
        coef: num(raw?.coef),
        lates: num(raw?.lates) ?? 0,
        letter: String(raw?.letter_mark ?? '').trim(),
        rcId: raw?.rc_id == null ? '' : String(raw.rc_id),
    };
}

// Moyenne générale pondérée par les ECTS (repli sur une moyenne simple si absents).
export function generalAverage(subjects: Subject[]): number | null {
    const graded = subjects.filter((s) => s.average !== null);
    if (!graded.length) return null;
    const totalEcts = graded.reduce((sum, s) => sum + (s.ects || 0), 0);
    if (totalEcts > 0) {
        const weighted = graded.reduce((sum, s) => sum + s.average! * (s.ects || 0), 0);
        return weighted / totalEcts;
    }
    return graded.reduce((sum, s) => sum + s.average!, 0) / graded.length;
}
