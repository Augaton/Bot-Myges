// Rendu graphique de l'emploi du temps en PNG (grille calendaire).
// Utilise @napi-rs/canvas : binaires précompilés, aucun build natif requis.
import { createCanvas, GlobalFonts, SKRSContext2D } from '@napi-rs/canvas';
import * as path from 'path';

// --- POLICES EMBARQUÉES ---
// On enregistre DejaVu Sans (bundlée dans le repo) pour un rendu identique
// quel que soit le serveur, même sans polices système installées.
const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
let fontsReady = false;
function ensureFonts() {
    if (fontsReady) return;
    try {
        GlobalFonts.registerFromPath(path.join(FONT_DIR, 'DejaVuSans.ttf'), 'AgendaSans');
        GlobalFonts.registerFromPath(path.join(FONT_DIR, 'DejaVuSans-Bold.ttf'), 'AgendaSansBold');
    } catch (e) {
        console.error('⚠️ Polices agenda non chargées, fallback système:', e);
    }
    fontsReady = true;
}
const FONT = 'AgendaSans';
const FONT_BOLD = 'AgendaSansBold';

// --- THÈME (aligné sur le dark mode Discord) ---
const COL = {
    bg: '#1e1f22',
    panel: '#2b2d31',
    grid: '#3a3c41',
    gridStrong: '#4a4d53',
    text: '#ffffff',
    muted: '#b5bac1',
    faint: '#80848e',
    now: '#f23f43',
};

// Palette catégorielle (accents lisibles sur fond sombre).
const PALETTE = ['#5865f2', '#3498db', '#2ecc71', '#1abc9c', '#e67e22', '#9b59b6', '#e91e63', '#f1c40f', '#16a085', '#eb459e'];
const EXAM_COLOR = '#f23f43';

interface Course {
    name: string;
    start: Date;
    end: Date;
    rooms: string;
    campus: string;
    teacher: string;
    distanciel: boolean;
    exam: boolean;
    color: string;
}

// --- Helpers ---
function cleanName(raw: string): string {
    return (raw || 'Cours').replace(/^T\d+\s-\s/i, '').trim();
}

function hashColor(name: string): string {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
}

function hexToRgba(hex: string, a: number): string {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function fmtHM(d: Date): string {
    return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
}

const DAY_LABELS = ['Dim.', 'Lun.', 'Mar.', 'Mer.', 'Jeu.', 'Ven.', 'Sam.'];
function dayHeader(d: Date): { label: string; date: string } {
    return {
        label: DAY_LABELS[d.getDay()],
        date: d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }),
    };
}

function sameDay(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Rectangle arrondi
function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
}

// Découpe un texte pour tenir dans une largeur donnée (max `maxLines` lignes).
function wrapText(ctx: SKRSContext2D, text: string, maxWidth: number, maxLines: number): string[] {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let line = '';
    for (const w of words) {
        const test = line ? `${line} ${w}` : w;
        if (ctx.measureText(test).width > maxWidth && line) {
            lines.push(line);
            line = w;
            if (lines.length === maxLines - 1) break;
        } else {
            line = test;
        }
    }
    if (lines.length < maxLines) lines.push(line);
    // Ellipse la dernière ligne si trop longue
    let last = lines[lines.length - 1] || '';
    while (ctx.measureText(last + '…').width > maxWidth && last.length > 1) last = last.slice(0, -1);
    if (last !== (lines[lines.length - 1] || '') && last) lines[lines.length - 1] = last + '…';
    return lines.filter(Boolean);
}

// Normalise un item d'agenda MyGes vers notre structure interne.
function toCourse(raw: any): Course {
    const name = cleanName(raw.name);
    const distanciel = raw.modality === 'Distanciel' || (raw.rooms && raw.rooms.some((r: any) => (r.name || '').toLowerCase().includes('distanciel')));
    const exam = /examen|partiel|soutenance|rattrapage|final/i.test(raw.name || '');
    let rooms = '';
    let campus = '';
    if (!distanciel && raw.rooms && raw.rooms.length > 0) {
        rooms = raw.rooms.map((r: any) => r.name).join(', ');
        campus = raw.rooms[0].campus || '';
    }
    return {
        name,
        start: new Date(raw.start_date),
        end: new Date(raw.end_date),
        rooms,
        campus,
        teacher: raw.teacher ? String(raw.teacher).replace('M. ', '').replace('Mme ', '') : '',
        distanciel,
        exam,
        color: exam ? EXAM_COLOR : hashColor(name),
    };
}

// --- RENDU PRINCIPAL ---
// dayDates : liste des jours (00:00) à afficher côte à côte.
function renderGrid(title: string, subtitle: string, dayDates: Date[], rawCourses: any[]): Buffer {
    ensureFonts();

    const courses = (rawCourses || []).map(toCourse).filter((c) => !isNaN(c.start.getTime()) && !isNaN(c.end.getTime()));

    // Plage horaire dynamique (bornée 8h–20h par défaut)
    let minH = 8;
    let maxH = 19;
    for (const c of courses) {
        minH = Math.min(minH, c.start.getHours());
        maxH = Math.max(maxH, c.end.getHours() + (c.end.getMinutes() > 0 ? 1 : 0));
    }
    minH = Math.max(0, Math.min(minH, 8));
    maxH = Math.min(24, Math.max(maxH, 19));

    // Géométrie
    const PAD = 28;
    const titleH = 78;
    const dayHeadH = 52;
    const gutterW = 58;
    const hourH = 68; // hauteur d'une heure
    const colGap = 6;
    const nDays = dayDates.length;
    const colW = nDays === 1 ? 560 : 190;

    const gridW = gutterW + nDays * colW;
    const width = PAD * 2 + gridW;
    const gridTop = PAD + titleH + dayHeadH;
    const gridH = (maxH - minH) * hourH;
    const height = gridTop + gridH + PAD;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'alphabetic';

    // Fond
    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, width, height);

    // Titre
    ctx.fillStyle = COL.text;
    ctx.font = `28px ${FONT_BOLD}`;
    ctx.fillText(title, PAD, PAD + 30);
    ctx.fillStyle = COL.muted;
    ctx.font = `16px ${FONT}`;
    ctx.fillText(subtitle, PAD, PAD + 56);

    const gridLeft = PAD + gutterW;

    // Panneau de grille
    ctx.fillStyle = COL.panel;
    roundRect(ctx, PAD, gridTop - dayHeadH, gridW, dayHeadH + gridH, 14);
    ctx.fill();

    // Lignes horaires + labels
    ctx.textAlign = 'right';
    for (let h = minH; h <= maxH; h++) {
        const y = gridTop + (h - minH) * hourH;
        ctx.strokeStyle = COL.grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(gridLeft, y + 0.5);
        ctx.lineTo(PAD + gridW, y + 0.5);
        ctx.stroke();

        ctx.fillStyle = COL.faint;
        ctx.font = `13px ${FONT}`;
        ctx.fillText(`${String(h).padStart(2, '0')}h`, gridLeft - 10, y + 4);
    }
    ctx.textAlign = 'left';

    // En-têtes de jour + séparateurs de colonnes + cours
    const now = new Date();
    dayDates.forEach((day, di) => {
        const colX = gridLeft + di * colW;
        const isToday = sameDay(day, now);

        // Séparateur vertical
        if (di > 0) {
            ctx.strokeStyle = COL.grid;
            ctx.beginPath();
            ctx.moveTo(colX + 0.5, gridTop);
            ctx.lineTo(colX + 0.5, gridTop + gridH);
            ctx.stroke();
        }

        // Surlignage colonne du jour courant
        if (isToday) {
            ctx.fillStyle = hexToRgba('#5865f2', 0.08);
            ctx.fillRect(colX, gridTop, colW, gridH);
        }

        // En-tête jour
        const hd = dayHeader(day);
        ctx.textAlign = 'center';
        const cx = colX + colW / 2;
        ctx.fillStyle = isToday ? '#ffffff' : COL.muted;
        ctx.font = `16px ${FONT_BOLD}`;
        ctx.fillText(hd.label, cx, gridTop - dayHeadH + 24);
        if (isToday) {
            // pastille date
            const dw = ctx.measureText(hd.date).width + 18;
            ctx.fillStyle = '#5865f2';
            roundRect(ctx, cx - dw / 2, gridTop - dayHeadH + 30, dw, 22, 11);
            ctx.fill();
            ctx.fillStyle = '#ffffff';
        } else {
            ctx.fillStyle = COL.faint;
        }
        ctx.font = `13px ${FONT}`;
        ctx.fillText(hd.date, cx, gridTop - dayHeadH + 45);
        ctx.textAlign = 'left';

        // Cours du jour
        const dayCourses = courses.filter((c) => sameDay(c.start, day)).sort((a, b) => a.start.getTime() - b.start.getTime());
        for (const c of dayCourses) {
            const startMin = c.start.getHours() * 60 + c.start.getMinutes() - minH * 60;
            const durMin = Math.max(30, (c.end.getTime() - c.start.getTime()) / 60000);
            const bx = colX + colGap;
            const by = gridTop + (startMin / 60) * hourH + 2;
            const bw = colW - colGap * 2;
            const bh = (durMin / 60) * hourH - 4;

            // Bloc
            ctx.fillStyle = hexToRgba(c.color, 0.16);
            roundRect(ctx, bx, by, bw, bh, 8);
            ctx.fill();
            // Barre d'accent gauche
            ctx.fillStyle = c.color;
            roundRect(ctx, bx, by, 5, bh, 3);
            ctx.fill();

            // Zone de texte (clippée à la hauteur du bloc)
            ctx.save();
            roundRect(ctx, bx, by, bw, bh, 8);
            ctx.clip();

            const tx = bx + 14;
            const tw = bw - 20;
            let ty = by + 18;

            ctx.fillStyle = COL.faint;
            ctx.font = `11px ${FONT}`;
            ctx.fillText(`${fmtHM(c.start)} – ${fmtHM(c.end)}`, tx, ty);
            ty += 17;

            ctx.fillStyle = COL.text;
            ctx.font = `14px ${FONT_BOLD}`;
            const nameLines = wrapText(ctx, c.name, tw, bh > 80 ? 3 : 2);
            for (const ln of nameLines) {
                ctx.fillText(ln, tx, ty);
                ty += 17;
            }

            ty += 2;
            ctx.fillStyle = COL.muted;
            ctx.font = `11px ${FONT}`;
            const loc = c.distanciel ? 'Distanciel' : c.rooms + (c.campus ? ` · ${c.campus}` : '');
            if (loc) {
                for (const ln of wrapText(ctx, loc, tw, 2)) {
                    ctx.fillText(ln, tx, ty);
                    ty += 15;
                }
            }
            if (c.teacher && bh > 96) {
                ctx.fillStyle = COL.faint;
                ctx.fillText(wrapText(ctx, c.teacher, tw, 1)[0] || '', tx, ty);
            }
            ctx.restore();
        }
    });

    // Ligne "maintenant" si un des jours affichés est aujourd'hui
    if (dayDates.some((d) => sameDay(d, now))) {
        const nowMin = now.getHours() * 60 + now.getMinutes() - minH * 60;
        if (nowMin >= 0 && nowMin <= (maxH - minH) * 60) {
            const y = gridTop + (nowMin / 60) * hourH;
            ctx.strokeStyle = COL.now;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(gridLeft, y);
            ctx.lineTo(PAD + gridW, y);
            ctx.stroke();
            ctx.fillStyle = COL.now;
            ctx.beginPath();
            ctx.arc(gridLeft, y, 4, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    return canvas.toBuffer('image/png');
}

// --- API publique ---

export function renderDayImage(courses: any[], date: Date): Buffer {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    const title = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    const cap = title.charAt(0).toUpperCase() + title.slice(1);
    const n = (courses || []).filter((c) => sameDay(new Date(c.start_date), d)).length;
    return renderGrid(cap, `${n} cours`, [d], courses);
}

export function renderWeekImage(courses: any[], weekStart: Date): Buffer {
    const start = new Date(weekStart);
    start.setHours(0, 0, 0, 0);

    // Lundi -> Vendredi, + samedi/dimanche uniquement s'ils ont des cours.
    const days: Date[] = [];
    for (let i = 0; i < 5; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        days.push(d);
    }
    for (const extra of [5, 6]) {
        const d = new Date(start);
        d.setDate(start.getDate() + extra);
        if ((courses || []).some((c) => sameDay(new Date(c.start_date), d))) days.push(d);
    }

    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    const subtitle = `Semaine du ${start.toLocaleDateString('fr-FR')} au ${end.toLocaleDateString('fr-FR')} · ${(courses || []).length} cours`;
    return renderGrid('Emploi du temps', subtitle, days, courses);
}
