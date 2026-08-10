// Rendu graphique des notes en PNG (vue d'ensemble en barres + fiche matière).
// Même identité visuelle que l'agenda : voir canvasBase pour le socle commun.
import { createCanvas, SKRSContext2D } from '@napi-rs/canvas';
import {
    COL, ellipsize, ensureFonts, fitText, FONT, FONT_BOLD, hexToRgba, roundRect,
} from './canvasBase';

// --- BARÈME / COULEURS ---
// Ordre décroissant : la première borne atteinte donne la couleur et la mention.
const BANDS = [
    { min: 16, color: '#f0b232', label: 'Excellent' },
    { min: 14, color: '#23a55a', label: 'Bien' },
    { min: 10, color: '#3b82f6', label: 'Validé' },
    { min: -Infinity, color: '#f23f43', label: 'Rattrapage' },
];
const CC_COLOR = '#949cf7'; // moyenne de contrôle continu (note non définitive)
const NONE_COLOR = '#4e5058';
const MAX_NOTE = 20;

export interface Subject {
    name: string;
    teacher: string;
    average: number | null; // moyenne définitive
    ccAverage: number | null; // moyenne de contrôle continu
    notes: number[]; // notes de contrôle continu
    exam: number | null;
    absences: number;
    ects: number | null;
}

export function bandOf(value: number): { color: string; label: string } {
    return BANDS.find((b) => value >= b.min)!;
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
    return {
        name,
        teacher,
        average: num(raw?.average),
        // Une moyenne CC à 0 signifie « pas encore de note » côté MyGes.
        ccAverage: cc && cc > 0 ? cc : null,
        notes,
        exam: num(raw?.exam),
        absences: num(raw?.absences) ?? 0,
        ects: num(raw?.ects),
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

// Valeur affichée pour une matière : note définitive, sinon moyenne CC provisoire.
function displayValue(s: Subject): { value: number | null; color: string; text: string; provisional: boolean } {
    if (s.average !== null) {
        return { value: s.average, color: bandOf(s.average).color, text: s.average.toFixed(2), provisional: false };
    }
    if (s.ccAverage !== null) {
        return { value: s.ccAverage, color: CC_COLOR, text: `~${s.ccAverage.toFixed(2)}`, provisional: true };
    }
    return { value: null, color: NONE_COLOR, text: '—', provisional: false };
}

// Barre horizontale sur une échelle 0-20, avec sa piste de fond.
function drawBar(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, value: number | null, color: string, provisional: boolean) {
    ctx.fillStyle = COL.track;
    roundRect(ctx, x, y, w, h, h / 2);
    ctx.fill();
    if (value === null || value <= 0) return;

    const filled = Math.max(h, (Math.min(value, MAX_NOTE) / MAX_NOTE) * w);
    ctx.fillStyle = provisional ? hexToRgba(color, 0.55) : color;
    roundRect(ctx, x, y, filled, h, h / 2);
    ctx.fill();
    if (provisional) {
        // Contour pointillé : la note n'est pas définitive.
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        roundRect(ctx, x + 0.5, y + 0.5, filled - 1, h - 1, (h - 1) / 2);
        ctx.stroke();
        ctx.restore();
    }
}

// --- VUE D'ENSEMBLE : une barre par matière ---
export function renderNotesOverview(subjects: Subject[], semester: string, highlight = -1): Buffer {
    ensureFonts();

    const PAD = 28;
    const width = 900;
    const innerPad = 18;
    const nameW = 244;
    const valueW = 104;
    const rowH = 38;
    const axisH = 30;
    const headerH = 84;
    const legendH = 36;
    const pillW = 186;
    const pillH = 62;

    const panelTop = PAD + headerH;
    const panelH = axisH + Math.max(subjects.length, 1) * rowH + 14;
    const height = panelTop + panelH + legendH + PAD;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, width, height);

    // --- En-tête : titre + compteurs, et pastille de moyenne générale à droite
    const graded = subjects.filter((s) => s.average !== null).length;
    const absences = subjects.reduce((sum, s) => sum + s.absences, 0);
    const gen = generalAverage(subjects);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = COL.text;
    ctx.font = `26px ${FONT_BOLD}`;
    ctx.fillText(ellipsize(ctx, semester || 'Mes notes', width - PAD * 2 - pillW - 20), PAD, PAD + 28);
    ctx.fillStyle = COL.muted;
    ctx.font = `14px ${FONT}`;
    const counters = `${subjects.length} matière${subjects.length > 1 ? 's' : ''} · ${graded} notée${graded > 1 ? 's' : ''} · ${absences} absence${absences > 1 ? 's' : ''}`;
    ctx.fillText(counters, PAD, PAD + 52);

    const pillX = width - PAD - pillW;
    ctx.fillStyle = COL.panel;
    roundRect(ctx, pillX, PAD - 4, pillW, pillH, 12);
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.fillStyle = COL.faint;
    ctx.font = `10px ${FONT_BOLD}`;
    ctx.fillText('MOYENNE GÉNÉRALE', pillX + pillW / 2, PAD + 15);
    ctx.font = `26px ${FONT_BOLD}`;
    ctx.fillStyle = gen === null ? COL.faint : bandOf(gen).color;
    ctx.fillText(gen === null ? '—' : `${gen.toFixed(2)}/20`, pillX + pillW / 2, PAD + 44);
    ctx.textAlign = 'left';

    // --- Panneau + géométrie du graphique
    ctx.fillStyle = COL.panel;
    roundRect(ctx, PAD, panelTop, width - PAD * 2, panelH, 14);
    ctx.fill();

    const chartX = PAD + innerPad + nameW + 14;
    const chartW = width - PAD - innerPad - valueW - chartX;
    const rowsTop = panelTop + axisH;
    const rowsBottom = rowsTop + subjects.length * rowH;

    // Échelle 0-20 + repères verticaux (le 10 = seuil de validation, en rouge)
    ctx.textAlign = 'center';
    for (const tick of [0, 5, 10, 15, 20]) {
        const x = chartX + (tick / MAX_NOTE) * chartW;
        ctx.fillStyle = tick === 10 ? hexToRgba(COL.now, 0.9) : COL.faint;
        ctx.font = `10px ${tick === 10 ? FONT_BOLD : FONT}`;
        ctx.fillText(String(tick), x, panelTop + 20);
        if (tick === 0 || tick === 20 || !subjects.length) continue;
        ctx.save();
        ctx.setLineDash(tick === 10 ? [] : [3, 4]);
        ctx.strokeStyle = tick === 10 ? hexToRgba(COL.now, 0.35) : COL.grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, rowsTop);
        ctx.lineTo(x + 0.5, rowsBottom);
        ctx.stroke();
        ctx.restore();
    }
    ctx.textAlign = 'left';

    if (!subjects.length) {
        ctx.fillStyle = COL.faint;
        ctx.font = `15px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.fillText('Aucune note pour ce trimestre', width / 2, rowsTop + 24);
        return canvas.toBuffer('image/png');
    }

    // --- Une ligne par matière
    subjects.forEach((s, i) => {
        const top = rowsTop + i * rowH;
        const mid = top + rowH / 2;
        const d = displayValue(s);

        // Matière actuellement ouverte en fiche détaillée : ligne surlignée.
        if (i === highlight) {
            ctx.fillStyle = hexToRgba(COL.accent, 0.14);
            roundRect(ctx, PAD + 8, top + 2, width - PAD * 2 - 16, rowH - 4, 8);
            ctx.fill();
            ctx.fillStyle = COL.accent;
            roundRect(ctx, PAD + 8, top + 6, 3, rowH - 12, 2);
            ctx.fill();
        }

        ctx.textBaseline = 'middle';
        ctx.fillStyle = i === highlight ? COL.text : COL.muted;
        ctx.font = `13px ${i === highlight ? FONT_BOLD : FONT}`;
        ctx.fillText(ellipsize(ctx, s.name, nameW), PAD + innerPad + 4, mid);

        drawBar(ctx, chartX, mid - 8, chartW, 16, d.value, d.color, d.provisional);

        ctx.textAlign = 'right';
        ctx.fillStyle = d.value === null ? COL.faint : d.color;
        ctx.font = `13px ${FONT_BOLD}`;
        ctx.fillText(d.text, width - PAD - innerPad, mid);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
    });

    // --- Légende des mentions
    ctx.textBaseline = 'middle';
    const legendY = panelTop + panelH + legendH / 2;
    const items: [string, string][] = [
        ...BANDS.map((b) => [b.color, b.min === -Infinity ? `< 10 ${b.label}` : `≥ ${b.min} ${b.label}`] as [string, string]),
        [CC_COLOR, 'Moyenne CC (provisoire)'],
    ];
    ctx.font = `12px ${FONT}`;
    const totalW = items.reduce((sum, [, label]) => sum + 14 + ctx.measureText(label).width + 20, 0);
    let lx = Math.max(PAD, (width - totalW) / 2);
    for (const [color, label] of items) {
        ctx.fillStyle = color;
        roundRect(ctx, lx, legendY - 5, 10, 10, 3);
        ctx.fill();
        ctx.fillStyle = COL.faint;
        ctx.fillText(label, lx + 14, legendY);
        lx += 14 + ctx.measureText(label).width + 20;
    }

    return canvas.toBuffer('image/png');
}

// --- FICHE MATIÈRE : jauge circulaire + détail des notes ---
export function renderSubjectCard(s: Subject, semester: string, index: number, total: number): Buffer {
    ensureFonts();

    const PAD = 28;
    const width = 900;
    const headerH = 82;
    const gaugeW = 258;
    const gap = 14;
    const noteRowH = 30;
    const shownNotes = s.notes.slice(0, 8);
    const bodyH = Math.max(236, 62 + shownNotes.length * noteRowH + 18);
    const chipsH = 68;
    const footerH = 24;
    const height = PAD + headerH + bodyH + gap + chipsH + footerH + PAD;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, width, height);

    const d = displayValue(s);

    // --- En-tête : matière + enseignant / trimestre
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = COL.text;
    const titleFit = fitText(ctx, s.name, width - PAD * 2, 62, FONT_BOLD, 27, 16);
    let ty = PAD + titleFit.size;
    for (const line of titleFit.lines) {
        ctx.font = `${titleFit.size}px ${FONT_BOLD}`;
        ctx.fillText(line, PAD, ty);
        ty += titleFit.lineH;
    }
    ctx.fillStyle = COL.faint;
    ctx.font = `13px ${FONT}`;
    ctx.fillText(ellipsize(ctx, [s.teacher, semester].filter(Boolean).join('  ·  '), width - PAD * 2), PAD, PAD + headerH - 12);

    const bodyTop = PAD + headerH;

    // --- Jauge circulaire de la moyenne
    ctx.fillStyle = COL.panel;
    roundRect(ctx, PAD, bodyTop, gaugeW, bodyH, 14);
    ctx.fill();

    const cx = PAD + gaugeW / 2;
    const cy = bodyTop + bodyH / 2 - 10;
    const r = 72;
    ctx.lineWidth = 16;
    ctx.strokeStyle = COL.track;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    if (d.value !== null && d.value > 0) {
        ctx.strokeStyle = d.color;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + (Math.min(d.value, MAX_NOTE) / MAX_NOTE) * Math.PI * 2);
        ctx.stroke();
        ctx.lineCap = 'butt';
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = d.value === null ? COL.faint : d.color;
    ctx.font = `34px ${FONT_BOLD}`;
    ctx.fillText(d.text, cx, cy - 6);
    ctx.fillStyle = COL.faint;
    ctx.font = `13px ${FONT}`;
    ctx.fillText(d.value === null ? 'non notée' : '/ 20', cx, cy + 22);

    // Mention sous la jauge
    const mention = d.value === null ? 'En attente' : d.provisional ? 'Contrôle continu' : bandOf(d.value).label;
    ctx.font = `13px ${FONT_BOLD}`;
    const mw = ctx.measureText(mention).width + 24;
    ctx.fillStyle = hexToRgba(d.color, 0.18);
    roundRect(ctx, cx - mw / 2, cy + r + 14, mw, 26, 13);
    ctx.fill();
    ctx.fillStyle = d.color;
    ctx.fillText(mention, cx, cy + r + 28);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    // --- Détail du contrôle continu
    const detX = PAD + gaugeW + gap;
    const detW = width - PAD - detX;
    ctx.fillStyle = COL.panel;
    roundRect(ctx, detX, bodyTop, detW, bodyH, 14);
    ctx.fill();

    ctx.fillStyle = COL.faint;
    ctx.font = `11px ${FONT_BOLD}`;
    ctx.fillText('CONTRÔLE CONTINU', detX + 18, bodyTop + 26);

    const barX = detX + 18 + 74;
    const barW = detW - 18 * 2 - 74 - 56;

    if (!shownNotes.length) {
        ctx.fillStyle = COL.faint;
        ctx.font = `14px ${FONT}`;
        ctx.fillText(
            s.ccAverage !== null ? `Moyenne CC : ${s.ccAverage.toFixed(2)}/20 (détail indisponible)` : 'Aucune note de contrôle continu',
            detX + 18, bodyTop + 60
        );
    } else {
        ctx.textBaseline = 'middle';
        shownNotes.forEach((note, i) => {
            const mid = bodyTop + 56 + i * noteRowH;
            ctx.fillStyle = COL.faint;
            ctx.font = `12px ${FONT}`;
            ctx.fillText(`Note ${i + 1}`, detX + 18, mid);
            drawBar(ctx, barX, mid - 7, barW, 14, note, bandOf(note).color, false);
            ctx.textAlign = 'right';
            ctx.fillStyle = bandOf(note).color;
            ctx.font = `13px ${FONT_BOLD}`;
            ctx.fillText(note.toFixed(2), detX + detW - 18, mid);
            ctx.textAlign = 'left';
        });
        ctx.textBaseline = 'alphabetic';
        if (s.notes.length > shownNotes.length) {
            ctx.fillStyle = COL.faint;
            ctx.font = `11px ${FONT}`;
            ctx.fillText(`+ ${s.notes.length - shownNotes.length} autre(s) note(s)`, detX + 18, bodyTop + bodyH - 14);
        }
    }

    // --- Bandeau de statistiques
    const chips: [string, string, string][] = [
        ['MOY. CC', s.ccAverage !== null ? `${s.ccAverage.toFixed(2)}/20` : '—', s.ccAverage !== null ? CC_COLOR : COL.faint],
        ['EXAMEN', s.exam !== null ? `${s.exam.toFixed(2)}/20` : '—', s.exam !== null ? bandOf(s.exam).color : COL.faint],
        ['CRÉDITS ECTS', s.ects !== null ? String(s.ects) : '—', COL.muted],
        ['ABSENCES', String(s.absences), s.absences > 0 ? COL.now : '#23a55a'],
    ];
    const chipsTop = bodyTop + bodyH + gap;
    const chipW = (width - PAD * 2 - gap * (chips.length - 1)) / chips.length;
    ctx.textAlign = 'center';
    chips.forEach(([label, value, color], i) => {
        const x = PAD + i * (chipW + gap);
        ctx.fillStyle = COL.panelAlt;
        roundRect(ctx, x, chipsTop, chipW, chipsH, 12);
        ctx.fill();
        ctx.fillStyle = COL.faint;
        ctx.font = `10px ${FONT_BOLD}`;
        ctx.fillText(label, x + chipW / 2, chipsTop + 24);
        ctx.fillStyle = color;
        ctx.font = `21px ${FONT_BOLD}`;
        ctx.fillText(value, x + chipW / 2, chipsTop + 52);
    });

    // --- Pied de page
    ctx.textAlign = 'left';
    ctx.fillStyle = COL.faint;
    ctx.font = `11px ${FONT}`;
    ctx.fillText(`Matière ${index + 1} / ${total}`, PAD, height - PAD + 6);

    return canvas.toBuffer('image/png');
}

// Couleur d'embed Discord (entier) associée à une matière, pour rester cohérent
// avec l'image générée.
export function subjectColor(s: Subject): number {
    return parseInt(displayValue(s).color.slice(1), 16);
}

// Emoji de mention utilisé dans les menus déroulants.
export function subjectEmoji(s: Subject): string {
    if (s.average === null) return s.ccAverage !== null ? '⏳' : '⬜';
    if (s.average >= 16) return '🏆';
    if (s.average >= 14) return '✅';
    if (s.average >= 10) return '👌';
    return '⚠️';
}

// Petit helper interne réutilisé par la commande pour l'affichage texte.
export function shortAverage(s: Subject): string {
    const d = displayValue(s);
    return d.value === null ? 'Non notée' : `${d.text}/20${d.provisional ? ' (CC)' : ''}`;
}
