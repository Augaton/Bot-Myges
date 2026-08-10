// Fonctions utilitaires de formatage partagées entre plusieurs commandes.

// Transforme un texte (potentiellement du HTML) en une ligne courte lisible.
export function snippet(raw: string, max = 120): string {
    if (!raw) return '';
    const clean = raw
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&[a-z]+;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
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
