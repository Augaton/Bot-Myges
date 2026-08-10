// Sélecteur de date pour l'agenda : helpers de dates et génération des options
// des menus déroulants Discord (semaines puis jours).
import { APISelectMenuOption } from 'discord.js';

export const DAY_MS = 86_400_000;
// Un menu déroulant Discord accepte 25 options : on propose 25 semaines autour
// du point d'ancrage, décalable avec les flèches du sélecteur.
export const WEEK_OPTIONS = 25;
export const WEEKS_BEFORE_ANCHOR = 8;

export const startOfDay = (d: Date): Date => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
};

// Décalage en jours calendaires (insensible aux changements d'heure).
export const addDays = (d: Date, n: number): Date => {
    const x = startOfDay(d);
    x.setDate(x.getDate() + n);
    return x;
};

export const getMonday = (d: Date): Date => {
    const date = startOfDay(d);
    const day = date.getDay();
    return addDays(date, day === 0 ? -6 : 1 - day);
};

export const sameDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

// Clé stable YYYY-MM-DD utilisée comme valeur d'option. En heure locale (et non
// en UTC) pour éviter qu'un fuseau décale le jour sélectionné.
export const dayKey = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const fromKey = (key: string): Date => {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
};

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const shortDate = (d: Date) => d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });

export function relativeWeek(monday: Date, thisMonday: Date): string {
    // Arrondi : un passage à l'heure d'été décale la différence d'une heure.
    const n = Math.round((monday.getTime() - thisMonday.getTime()) / (7 * DAY_MS));
    if (n === 0) return 'Cette semaine';
    if (n === 1) return 'Semaine prochaine';
    if (n === -1) return 'Semaine dernière';
    return n > 0 ? `Dans ${n} semaines` : `Il y a ${-n} semaines`;
}

export function relativeDay(day: Date, today: Date): string {
    const n = Math.round((startOfDay(day).getTime() - startOfDay(today).getTime()) / DAY_MS);
    if (n === 0) return "Aujourd'hui";
    if (n === 1) return 'Demain';
    if (n === -1) return 'Hier';
    if (n === 2) return 'Après-demain';
    return n > 0 ? `Dans ${n} jours` : `Il y a ${-n} jours`;
}

/**
 * 25 semaines centrées sur `anchor` (8 avant, 16 après), la semaine `selected`
 * étant pré-cochée et la semaine en cours repérée par 📍.
 */
export function weekOptions(anchor: Date, selected: Date, today: Date): APISelectMenuOption[] {
    const thisMonday = getMonday(today);
    const first = addDays(getMonday(anchor), -WEEKS_BEFORE_ANCHOR * 7);
    return Array.from({ length: WEEK_OPTIONS }, (_, i) => {
        const monday = addDays(first, i * 7);
        const month = capitalize(monday.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }));
        return {
            label: `Semaine du ${shortDate(monday)} au ${shortDate(addDays(monday, 6))}`.slice(0, 100),
            value: dayKey(monday),
            description: `${month} · ${relativeWeek(monday, thisMonday)}`.slice(0, 100),
            emoji: { name: sameDay(monday, thisMonday) ? '📍' : '📅' },
            default: sameDay(monday, getMonday(selected)),
        };
    });
}

/** Les 7 jours de la semaine de `monday`, `selected` étant pré-coché. */
export function dayOptions(monday: Date, selected: Date, today: Date): APISelectMenuOption[] {
    return Array.from({ length: 7 }, (_, i) => {
        const d = addDays(monday, i);
        return {
            label: capitalize(d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })).slice(0, 100),
            value: dayKey(d),
            description: relativeDay(d, today).slice(0, 100),
            emoji: { name: sameDay(d, today) ? '📍' : '📆' },
            default: sameDay(d, selected),
        };
    });
}
