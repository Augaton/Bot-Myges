// Campus de l'ESGI connus du bot. Les adresses sont publiques ; les codes d'accès,
// eux, ne figurent jamais dans le dépôt : ils sont lus dans campus.json par /campus seul.

/** Bâtiments du réseau, dans l'ordre de /campus. `code` est leur clé dans campus.json. */
export const BUILDINGS = [
    { code: 'nation', label: '🏢 Nation 1 & 2', address: '242 Rue du Faubourg Saint-Antoine, 75012 Paris' },
    { code: 'erard', label: '🏢 Erard', address: '21 Rue Erard, 75012 Paris' },
    { code: 'voltaire1', label: '🎨 Voltaire 1 (Studio Crea)', address: '1 Rue Bouvier, 75011 Paris' },
    { code: 'voltaire2', label: '📷 Voltaire 2 (Efet)', address: '1 Rue Bouvier, 75011 Paris' },
    { code: 'rauch', label: '🏛️ Rauch', address: '15 Rue Rames, 75012 Paris' },
];

/** Campus tels que MyGes les nomme dans l'agenda (NATION1, VOLTAIRE2…), et leur bâtiment. */
const AGENDA_CAMPUSES: Record<string, { name: string; building: string }> = {
    nation1: { name: 'Nation 1', building: 'nation' },
    nation2: { name: 'Nation 2', building: 'nation' },
    erard: { name: 'Erard', building: 'erard' },
    voltaire1: { name: 'Voltaire 1', building: 'voltaire1' },
    voltaire2: { name: 'Voltaire 2', building: 'voltaire2' },
    rauch: { name: 'Rauch', building: 'rauch' },
};

export interface CourseCampus {
    /** Clé stable, qui choisit la couleur dans le panel : nation1…, distanciel, ou autre. */
    key: string;
    name: string;
    /** Vide pour un campus inconnu ou à distance. */
    address: string;
}

export const REMOTE_CAMPUS: CourseCampus = { key: 'distanciel', name: 'Distanciel', address: '' };

/** Campus d'une valeur MyGes (« NATION1 », « Voltaire 2 »…), ou null si elle est vide. */
export function campusOf(raw: string): CourseCampus | null {
    const key = raw.toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');
    if (!key) return null;
    const known = AGENDA_CAMPUSES[key];
    if (!known) {
        // Un autre campus du réseau (Reims, Lyon…) : son nom, sans adresse ni couleur propre.
        const name = raw.trim().toLowerCase().replace(/^./, (c) => c.toUpperCase()).replace(/(\D)(\d+)$/, '$1 $2');
        return { key: 'autre', name, address: '' };
    }
    const building = BUILDINGS.find((b) => b.code === known.building);
    return { key, name: known.name, address: building?.address ?? '' };
}
