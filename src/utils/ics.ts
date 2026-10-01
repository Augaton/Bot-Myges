// Export de l'emploi du temps au format iCalendar (RFC 5545), importable dans
// Google Agenda, Apple Calendrier, Outlook, etc.
import { courseName, formatCampus } from './format';

const CRLF = '\r\n';

/** Échappement d'une valeur texte (RFC 5545 §3.3.11). */
export function escapeText(text: string): string {
    return text
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\;')
        .replace(/,/g, '\\,')
        .replace(/\r?\n/g, '\\n');
}

/** Date en UTC au format iCalendar (20260928T070000Z) : aucun fuseau à décrire. */
export function icsDate(d: Date): string {
    return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Replie une ligne trop longue (75 octets au plus, RFC 5545 §3.1) sans couper
 * un caractère UTF-8 en deux : les accents comptent pour 2 octets.
 */
export function foldLine(line: string): string {
    const parts: string[] = [];
    let current = '';
    let bytes = 0;
    for (const ch of line) {
        const size = Buffer.byteLength(ch, 'utf8');
        // Les lignes de continuation commencent par une espace, qui compte.
        const limit = parts.length === 0 ? 75 : 74;
        if (bytes + size > limit) {
            parts.push(current);
            current = '';
            bytes = 0;
        }
        current += ch;
        bytes += size;
    }
    parts.push(current);
    return parts.join(`${CRLF} `);
}

/** Calendrier .ics des cours MyGes donnés (items bruts de l'API agenda). */
export function buildIcs(courses: any[], now = new Date()): string {
    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//MyGes Bot//Emploi du temps//FR',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'X-WR-CALNAME:Cours MyGes',
        'X-WR-TIMEZONE:Europe/Paris',
    ];
    const stamp = icsDate(now);
    const seen = new Set<string>();

    for (const c of courses) {
        const start = new Date(c?.start_date);
        const end = new Date(c?.end_date);
        if (isNaN(start.getTime()) || isNaN(end.getTime())) continue;

        // UID stable par réservation MyGes : un agenda qui réimporte le
        // fichier peut reconnaître les cours déjà présents.
        const uid = `myges-${c.reservation_id ?? `${start.getTime()}-${end.getTime()}`}@botmyges`;
        if (seen.has(uid)) continue;
        seen.add(uid);

        const rooms: any[] = Array.isArray(c.rooms) ? c.rooms : [];
        const distanciel = c.modality === 'Distanciel' || rooms.some((r) => String(r?.name ?? '').toLowerCase().includes('distanciel'));
        let location = '';
        if (distanciel) location = 'Distanciel';
        else if (rooms.length) {
            location = rooms.map((r) => r?.name).filter(Boolean).join(', ');
            const campus = formatCampus(rooms[0]?.campus || '');
            if (campus) location += ` (${campus})`;
        }
        const description = [
            c.teacher && `Intervenant : ${c.teacher}`,
            c.modality && `Modalité : ${c.modality}`,
            c.type && `Type : ${c.type}`,
        ].filter(Boolean).join('\n');

        lines.push(
            'BEGIN:VEVENT',
            `UID:${uid}`,
            `DTSTAMP:${stamp}`,
            `DTSTART:${icsDate(start)}`,
            `DTEND:${icsDate(end)}`,
            `SUMMARY:${escapeText(courseName(c))}`,
        );
        if (location) lines.push(`LOCATION:${escapeText(location)}`);
        if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
        lines.push('END:VEVENT');
    }

    lines.push('END:VCALENDAR');
    return lines.map(foldLine).join(CRLF) + CRLF;
}
