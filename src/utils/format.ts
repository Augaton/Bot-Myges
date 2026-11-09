// Fonctions utilitaires de formatage partagées entre plusieurs commandes.

// Entités des textes MyGes : les accents français, la ponctuation typographique
// et les caractères réservés du HTML.
const HTML_ENTITIES: Record<string, string> = {
    nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
    hellip: '…', ndash: '–', mdash: '—', laquo: '«', raquo: '»', deg: '°', euro: '€', oelig: 'œ',
    agrave: 'à', acirc: 'â', ccedil: 'ç', eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', icirc: 'î', iuml: 'ï',
    ocirc: 'ô', ouml: 'ö', ugrave: 'ù', ucirc: 'û', uuml: 'ü',
    Agrave: 'À', Ccedil: 'Ç', Eacute: 'É', Egrave: 'È', Ecirc: 'Ê',
};

function decodeEntity(_entity: string, name: string): string {
    if (name[0] !== '#') return HTML_ENTITIES[name] ?? ' ';
    const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
}

// Un aperçu fait quelques centaines de caractères : au-delà, le texte ne servirait
// à rien et coûterait du temps sur le thread principal.
const MAX_SNIPPET_INPUT = 20_000;

function toText(raw: unknown, lineBreak: string): string {
    return String(raw)
        .slice(0, MAX_SNIPPET_INPUT)
        .replace(/<br\s*\/?>|<\/(?:p|div|li|tr|h[1-6])\s*>/gi, lineBreak)
        // [^<>] et non [^>] : sur une suite de « < », ce dernier devient quadratique
        // (66 s de gel pour 200 000 caractères, mesurés).
        .replace(/<[^<>]+>/g, ' ')
        // Après le retrait des balises : un « &lt;b&gt; » est du texte, pas du HTML.
        .replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, decodeEntity);
}

const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max - 1) + '…' : text);

// Transforme un texte (potentiellement du HTML) en une ligne courte lisible.
export function snippet(raw: unknown, max = 120): string {
    if (!raw) return '';
    return clip(toText(raw, ' ').replace(/\s+/g, ' ').trim(), max);
}

/** Comme snippet, mais garde les paragraphes : à afficher avec `white-space: pre-line`. */
export function paragraphs(raw: unknown, max = 1_000): string {
    if (!raw) return '';
    const clean = toText(raw, '\n')
        .replace(/[^\S\n]+/g, ' ')
        .replace(/ ?\n ?/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return clip(clean, max);
}

/**
 * Tri alphabétique par nom de famille, tolérant aux champs manquants : l'API
 * MyGes renvoie parfois un `lastname` absent, ce qui faisait échouer toute la
 * commande sur un `localeCompare` de `undefined`.
 */
export function byLastName(a: any, b: any): number {
    return String(a?.lastname ?? '').localeCompare(String(b?.lastname ?? ''), 'fr');
}

/** Nom affichable d'une personne, jamais vide (Discord refuse les champs vides). */
export function fullName(p: any): string {
    const name = [p?.firstname, p?.lastname].filter(Boolean).join(' ').trim();
    return name || 'Nom inconnu';
}

/** Nom d'un cours sans le préfixe de trimestre (« T1 - Anglais » → « Anglais »). */
export function courseName(raw: any): string {
    return String(raw?.name || 'Cours').replace(/^T\d+\s-\s/i, '').trim();
}

/**
 * Lieu d'un cours : « Distanciel », ou ses salles suivies du campus
 * (« Salle 12 (Nation 1) »). Vide tant qu'aucune salle n'est attribuée.
 */
export function coursePlace(raw: any): string {
    const rooms: any[] = Array.isArray(raw?.rooms) ? raw.rooms : [];
    if (raw?.modality === 'Distanciel' || rooms.some((r) => String(r?.name ?? '').toLowerCase().includes('distanciel'))) {
        return 'Distanciel';
    }
    // Triées : un ordre qui varie d'une lecture à l'autre n'est pas un changement de salle.
    const names = rooms.map((r) => String(r?.name ?? '')).filter(Boolean).sort((a, b) => a.localeCompare(b, 'fr')).join(', ');
    if (!names) return '';
    const campus = formatCampus(rooms[0]?.campus || '');
    return campus ? `${names} (${campus})` : names;
}

export function formatToFrenchTime(date: Date): string {
    return date.toLocaleTimeString('fr-FR', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Europe/Paris',
    });
}

// --- Trouver la prochaine étape d'un projet ---
export function getNextStep(project: any) {
    const now = Date.now();

    // Si pas d'étapes, on regarde la date de fin globale
    if (!project.steps || project.steps.length === 0) {
        if (project.end_date && parseInt(project.end_date) > now) {
            return {
                date: parseInt(project.end_date),
                type: 'Rendu Final',
                desc: 'Fin du projet',
            };
        }
        return null; // Projet fini ou sans date
    }

    // On cherche les étapes FUTURES
    const futureSteps = project.steps.filter((s: any) => s.psp_limit_date >= now);
    if (futureSteps.length === 0) return null; // Plus d'étapes futures

    // On trie pour avoir la plus proche
    futureSteps.sort((a: any, b: any) => a.psp_limit_date - b.psp_limit_date);

    return {
        date: futureSteps[0].psp_limit_date,
        type: futureSteps[0].psp_type || 'Étape',
        desc: futureSteps[0].psp_desc || '',
    };
}

// --- Formater le nom du campus (ex: NATION1 -> Nation 1) ---
export function formatCampus(rawCampus: string): string {
    if (!rawCampus) return '';

    // On met tout en minuscule sauf la 1ère lettre
    let s = rawCampus.toLowerCase(); // nation1
    s = s.charAt(0).toUpperCase() + s.slice(1); // Nation1

    // Petits ajustements pour faire propre
    s = s
        .replace('Nation1', 'Nation 1')
        .replace('Nation2', 'Nation 2')
        .replace('Voltaire1', 'Voltaire 1')
        .replace('Voltaire2', 'Voltaire 2');

    return s;
}

// --- Icône selon la matière (Version Étendue) ---
// Table de correspondance mots-clés -> emoji, évaluée dans l'ordre.
const COURSE_ICONS: { keywords: string[]; icon: string }[] = [
    // 1. MODALITÉS SPÉCIALES
    { keywords: ['examen', 'partiel', 'soutenance', 'final'], icon: '🔴' },
    { keywords: ['rattrapage'], icon: '🆘' },
    // 2. LANGAGES DE PROGRAMMATION
    { keywords: ['java', 'spring', 'jee'], icon: '☕' },
    { keywords: ['web', 'html', 'css', 'js', 'react', 'angular', 'vue', 'node', 'typescript'], icon: '🌐' },
    { keywords: ['php', 'symfony', 'laravel'], icon: '🐘' },
    { keywords: ['python', 'django', 'flask'], icon: '🐍' },
    { keywords: ['c#', '.net', 'dotnet'], icon: '🔷' },
    { keywords: ['cpp', 'c++', ' c ', 'langage c'], icon: '🇨' },
    { keywords: ['swift', 'ios', 'apple', 'xcode'], icon: '🍎' },
    { keywords: ['android', 'kotlin', 'mobile', 'flutter'], icon: '📱' },
    { keywords: ['go', 'golang', 'rust'], icon: '🦀' },
    { keywords: ['assembleur', 'assembly', ' asm ', 'microprocesseur'], icon: '⚙️' },
    // 3. INFRASTRUCTURE & DATA
    { keywords: ['data', 'sql', 'base de données', 'mongo', 'postgre', 'oracle'], icon: '💾' },
    { keywords: ['cloud', 'aws', 'azure', 'docker', 'kubernetes', 'devops', 'ci/cd'], icon: '☁️' },
    { keywords: ['linux', 'unix', 'bash', 'shell', 'système'], icon: '🐧' },
    { keywords: ['reseau', 'réseau', 'cisco', 'network'], icon: '🔌' },
    { keywords: ['sécurité', 'security', 'cyber', 'pentest', 'hacking'], icon: '🛡️' },
    // 4. MÉTIERS & SOFT SKILLS
    { keywords: ['gestion', 'management', 'chef de projet', 'agile', 'scrum'], icon: '🤝' },
    { keywords: ['droit', 'juridique', 'rgpd', 'law'], icon: '⚖️' },
    { keywords: ['anglais', 'english', 'toeic'], icon: '🇬🇧' },
    { keywords: ['communication', 'expression', 'rh', 'cv'], icon: '📢' },
    { keywords: ['math', 'algebre', 'probabilité', 'statistique'], icon: '📐' },
    // 5. CRÉATION & IA
    { keywords: ['design', 'ux', 'ui', 'photoshop', 'illustrator', 'ergonomie'], icon: '🎨' },
    { keywords: ['jeu', 'game', 'unity', 'unreal'], icon: '🎮' },
    { keywords: ['ia ', 'intelligence', 'machine learning', 'deep learning'], icon: '🧠' },
    { keywords: ['architecture', 'conception', 'uml', 'merise'], icon: '🏗️' },
    // 6. DIVERS
    { keywords: ['projet', 'workshop', 'hackathon'], icon: '🚀' },
    { keywords: ['conférence', 'seminaire', 'masterclass'], icon: '🎤' },
];

export function getCourseIcon(name: string, modality: string): string {
    const n = name.toLowerCase();

    // Modalité distancielle prioritaire
    if (modality === 'Distanciel' || n.includes('distanciel')) return '🏠';

    for (const { keywords, icon } of COURSE_ICONS) {
        if (keywords.some((k) => n.includes(k))) return icon;
    }

    return '📘'; // Défaut
}
