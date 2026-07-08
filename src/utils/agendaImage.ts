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
    text: '#ffffff',
    muted: '#b5bac1',
    faint: '#80848e',
    now: '#f23f43',
};

// --- COULEURS PAR CAMPUS ---
const CAMPUS_COLORS: Record<string, string> = {
    'Nation 1': '#3498db',
    'Nation 2': '#1abc9c',
    Erard: '#e67e22',
    'Voltaire 1': '#9b59b6',
    'Voltaire 2': '#e91e63',
    Rauch: '#2ecc71',
    Distanciel: '#8b93a7',
    Autre: '#747f8d',
};
// Palette de secours pour un campus inconnu non listé ci-dessus.
const FALLBACK = ['#5865f2', '#f1c40f', '#16a085', '#eb459e', '#e74c3c', '#00b8d9'];
const EXAM_BORDER = '#f23f43';

interface Course {
    name: string;
    start: Date;
    end: Date;
    rooms: string;
    campusKey: string;
    teacher: string;
    distanciel: boolean;
    exam: boolean;
    color: string;
    col: number; // sous-colonne (anti-superposition)
    cols: number; // nombre de sous-colonnes du groupe
}

// --- Helpers ---
function cleanName(raw: string): string {
    return (raw || 'Cours').replace(/^T\d+\s-\s/i, '').trim();
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

// Normalise le libellé de campus renvoyé par l'API en une clé stable.
function campusKey(raw: string, distanciel: boolean): string {
    if (distanciel) return 'Distanciel';
    if (!raw) return 'Autre';
    const s = raw.toLowerCase().replace(/[\s_-]/g, '');
    if (s.includes('nation1')) return 'Nation 1';
    if (s.includes('nation2')) return 'Nation 2';
    if (s.includes('voltaire1')) return 'Voltaire 1';
    if (s.includes('voltaire2')) return 'Voltaire 2';
    if (s.includes('erard')) return 'Erard';
    if (s.includes('rauch')) return 'Rauch';
    return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

// Rectangle arrondi
function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
    const rad = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
}

// Découpe un texte pour une largeur donnée à la police courante (déjà settée).
function wrapAt(ctx: SKRSContext2D, text: string, maxW: number): string[] {
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = '';
    const pushBroken = (chunk: string) => {
        // Coupe un mot plus large que la colonne.
        let cur = chunk;
        while (ctx.measureText(cur).width > maxW && cur.length > 1) {
            let cut = cur.length - 1;
            while (cut > 1 && ctx.measureText(cur.slice(0, cut)).width > maxW) cut--;
            lines.push(cur.slice(0, cut));
            cur = cur.slice(cut);
        }
        line = cur;
    };
    for (const w of words) {
        const test = line ? `${line} ${w}` : w;
        if (ctx.measureText(test).width > maxW && line) {
            lines.push(line);
            if (ctx.measureText(w).width > maxW) pushBroken(w);
            else line = w;
        } else if (ctx.measureText(test).width > maxW) {
            pushBroken(w);
        } else {
            line = test;
        }
    }
    if (line) lines.push(line);
    return lines;
}

// Choisit la plus grande taille de police (entre min et max) pour que `text`
// tienne entièrement dans (maxW x maxH). Ellipse en dernier recours.
function fitText(
    ctx: SKRSContext2D, text: string, maxW: number, maxH: number,
    family: string, max: number, min: number
): { lines: string[]; size: number; lineH: number } {
    for (let size = max; size >= min; size--) {
        ctx.font = `${size}px ${family}`;
        const lineH = size + 3;
        const lines = wrapAt(ctx, text, maxW);
        if (lines.length * lineH <= maxH) return { lines, size, lineH };
    }
    // Taille mini : on tronque au nombre de lignes possible.
    const size = min;
    const lineH = size + 3;
    ctx.font = `${size}px ${family}`;
    let lines = wrapAt(ctx, text, maxW);
    const maxLines = Math.max(1, Math.floor(maxH / lineH));
    if (lines.length > maxLines) {
        lines = lines.slice(0, maxLines);
        let last = lines[maxLines - 1];
        while (ctx.measureText(last + '…').width > maxW && last.length > 1) last = last.slice(0, -1);
        lines[maxLines - 1] = last + '…';
    }
    return { lines, size, lineH };
}

// Normalise un item d'agenda MyGes vers notre structure interne.
function toCourse(raw: any): Course {
    const name = cleanName(raw.name);
    const distanciel = raw.modality === 'Distanciel' || (raw.rooms && raw.rooms.some((r: any) => (r.name || '').toLowerCase().includes('distanciel')));
    const exam = /examen|partiel|soutenance|rattrapage|final/i.test(raw.name || '');
    let rooms = '';
    let campusRaw = '';
    if (!distanciel && raw.rooms && raw.rooms.length > 0) {
        rooms = raw.rooms.map((r: any) => r.name).join(', ');
        campusRaw = raw.rooms[0].campus || '';
    }
    return {
        name,
        start: new Date(raw.start_date),
        end: new Date(raw.end_date),
        rooms,
        campusKey: campusKey(campusRaw, distanciel),
        teacher: raw.teacher ? String(raw.teacher).replace('M. ', '').replace('Mme ', '') : '',
        distanciel,
        exam,
        color: '#747f8d',
        col: 0,
        cols: 1,
    };
}

// Anti-superposition : attribue à chaque cours d'une journée une sous-colonne
// (col / cols) de sorte que deux cours qui se chevauchent soient côte à côte.
function layoutDay(events: Course[]) {
    events.sort((a, b) => a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime());
    let group: Course[] = [];
    let colEnds: number[] = []; // fin (ms) du dernier cours de chaque colonne
    let groupEnd = -Infinity;

    const flush = () => {
        for (const e of group) e.cols = colEnds.length || 1;
        group = [];
        colEnds = [];
        groupEnd = -Infinity;
    };

    for (const ev of events) {
        if (ev.start.getTime() >= groupEnd && group.length) flush();
        let placed = false;
        for (let c = 0; c < colEnds.length; c++) {
            if (ev.start.getTime() >= colEnds[c]) {
                ev.col = c;
                colEnds[c] = ev.end.getTime();
                placed = true;
                break;
            }
        }
        if (!placed) {
            ev.col = colEnds.length;
            colEnds.push(ev.end.getTime());
        }
        group.push(ev);
        groupEnd = Math.max(groupEnd, ev.end.getTime());
    }
    if (group.length) flush();
}

// --- RENDU PRINCIPAL ---
function renderGrid(title: string, subtitle: string, dayDates: Date[], rawCourses: any[]): Buffer {
    ensureFonts();

    const courses = (rawCourses || []).map(toCourse).filter((c) => !isNaN(c.start.getTime()) && !isNaN(c.end.getTime()));

    // Couleurs par campus (connus + secours pour inconnus), dans l'ordre d'apparition.
    const campusColor = new Map<string, string>();
    let fi = 0;
    for (const c of courses) {
        if (!campusColor.has(c.campusKey)) {
            campusColor.set(c.campusKey, CAMPUS_COLORS[c.campusKey] || FALLBACK[fi++ % FALLBACK.length]);
        }
        c.color = campusColor.get(c.campusKey)!;
    }

    // Plage horaire dynamique (bornée 8h–19h par défaut)
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
    const dayHeadH = 52;
    const gutterW = 58;
    const hourH = 72;
    const colGap = 6;
    const nDays = dayDates.length;
    const colW = nDays === 1 ? 560 : 190;

    const gridW = gutterW + nDays * colW;
    const width = PAD * 2 + gridW;

    // En-tête + légende (hauteur dynamique selon le nombre de campus)
    const legendItems = [...campusColor.entries()];
    const headerTop = PAD + 66; // titre + sous-titre
    const legendRowH = 24;
    // On mesure combien d'items tiennent par ligne
    const tmp = createCanvas(10, 10).getContext('2d');
    tmp.font = `13px ${FONT}`;
    const itemW = (label: string) => 18 + tmp.measureText(label).width + 18;
    let legendRows = legendItems.length ? 1 : 0;
    {
        let x = 0;
        for (const [label] of legendItems) {
            const w = itemW(label);
            if (x + w > gridW && x > 0) {
                legendRows++;
                x = 0;
            }
            x += w;
        }
    }
    const legendH = legendRows * legendRowH;
    const gridTop = headerTop + legendH + 10 + dayHeadH;
    const gridH = (maxH - minH) * hourH;
    const height = gridTop + gridH + PAD;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Fond
    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, width, height);

    // Titre + sous-titre
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = COL.text;
    ctx.font = `28px ${FONT_BOLD}`;
    ctx.fillText(title, PAD, PAD + 30);
    ctx.fillStyle = COL.muted;
    ctx.font = `15px ${FONT}`;
    ctx.fillText(subtitle, PAD, PAD + 54);

    // Légende campus
    ctx.textBaseline = 'middle';
    let lx = PAD;
    let ly = headerTop + 12;
    for (const [label, color] of legendItems) {
        const w = itemW(label);
        if (lx - PAD + w > gridW && lx > PAD) {
            lx = PAD;
            ly += legendRowH;
        }
        ctx.fillStyle = color;
        roundRect(ctx, lx, ly - 6, 12, 12, 3);
        ctx.fill();
        ctx.fillStyle = COL.muted;
        ctx.font = `13px ${FONT}`;
        ctx.fillText(label, lx + 18, ly + 1);
        lx += w;
    }

    const gridLeft = PAD + gutterW;

    // Panneau de grille
    ctx.fillStyle = COL.panel;
    roundRect(ctx, PAD, gridTop - dayHeadH, gridW, dayHeadH + gridH, 14);
    ctx.fill();

    // Lignes horaires + labels
    ctx.textBaseline = 'alphabetic';
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

    // En-têtes de jour + cours
    const now = new Date();
    dayDates.forEach((day, di) => {
        const colX = gridLeft + di * colW;
        const isToday = sameDay(day, now);

        if (di > 0) {
            ctx.strokeStyle = COL.grid;
            ctx.beginPath();
            ctx.moveTo(colX + 0.5, gridTop);
            ctx.lineTo(colX + 0.5, gridTop + gridH);
            ctx.stroke();
        }
        if (isToday) {
            ctx.fillStyle = hexToRgba('#5865f2', 0.08);
            ctx.fillRect(colX, gridTop, colW, gridH);
        }

        // En-tête jour
        const hd = dayHeader(day);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        const cx = colX + colW / 2;
        ctx.fillStyle = isToday ? '#ffffff' : COL.muted;
        ctx.font = `16px ${FONT_BOLD}`;
        ctx.fillText(hd.label, cx, gridTop - dayHeadH + 24);
        if (isToday) {
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

        // Cours du jour (avec anti-superposition)
        const dayCourses = courses.filter((c) => sameDay(c.start, day));
        layoutDay(dayCourses);
        for (const c of dayCourses) {
            const startMin = c.start.getHours() * 60 + c.start.getMinutes() - minH * 60;
            const durMin = Math.max(30, (c.end.getTime() - c.start.getTime()) / 60000);
            const usableW = colW - colGap * 2;
            const subW = usableW / c.cols;
            const bx = colX + colGap + c.col * subW + (c.col > 0 ? 2 : 0);
            const bw = subW - (c.cols > 1 ? 4 : 0);
            const by = gridTop + (startMin / 60) * hourH + 2;
            const bh = (durMin / 60) * hourH - 4;

            drawBlock(ctx, c, bx, by, bw, bh);
        }
    });

    // Ligne "maintenant"
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

// Dessine un bloc de cours avec texte adapté dynamiquement à sa taille.
function drawBlock(ctx: SKRSContext2D, c: Course, bx: number, by: number, bw: number, bh: number) {
    // Fond teinté + barre d'accent + éventuelle bordure "examen"
    ctx.fillStyle = hexToRgba(c.color, 0.18);
    roundRect(ctx, bx, by, bw, bh, 8);
    ctx.fill();
    ctx.fillStyle = c.color;
    roundRect(ctx, bx, by, 5, bh, 3);
    ctx.fill();
    if (c.exam) {
        ctx.strokeStyle = EXAM_BORDER;
        ctx.lineWidth = 2;
        roundRect(ctx, bx + 1, by + 1, bw - 2, bh - 2, 7);
        ctx.stroke();
    }

    ctx.save();
    roundRect(ctx, bx, by, bw, bh, 8);
    ctx.clip();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    const padX = 8;
    const innerX = bx + 7 + padX;
    const innerW = bw - (7 + padX) - padX;
    const padY = 6;
    let cy = by + padY;

    if (innerW < 26) {
        ctx.restore();
        return; // colonne trop étroite : on laisse la couleur parler
    }

    // Ligne horaire (compacte)
    const timeSize = bh < 46 ? 9 : 10;
    ctx.font = `${timeSize}px ${FONT}`;
    ctx.fillStyle = COL.faint;
    ctx.fillText(`${fmtHM(c.start)} – ${fmtHM(c.end)}`, innerX, cy);
    cy += timeSize + 4;

    // Métadonnées à afficher selon la place disponible
    const loc = c.distanciel ? 'Distanciel' : c.rooms + (c.campusKey && c.campusKey !== 'Autre' ? ` · ${c.campusKey}` : '');
    const wantLoc = bh >= 48 && loc;
    const wantTeacher = bh >= 78 && c.teacher;

    // Réserve verticale pour loc + prof (mesurée à 10px)
    let metaLines: { text: string; color: string }[] = [];
    if (wantLoc) {
        ctx.font = `10px ${FONT}`;
        for (const ln of wrapAt(ctx, loc, innerW).slice(0, bh >= 70 ? 2 : 1)) metaLines.push({ text: ln, color: COL.muted });
    }
    if (wantTeacher) {
        ctx.font = `10px ${FONT}`;
        metaLines.push({ text: wrapAt(ctx, c.teacher, innerW)[0] || '', color: COL.faint });
    }
    const metaH = metaLines.length * 13;

    // Titre : occupe l'espace restant, taille adaptée pour tout faire tenir
    const titleMaxH = by + bh - padY - cy - metaH - (metaLines.length ? 4 : 0);
    if (titleMaxH >= 11) {
        const fit = fitText(ctx, c.name, innerW, titleMaxH, FONT_BOLD, 15, 9);
        ctx.fillStyle = COL.text;
        ctx.font = `${fit.size}px ${FONT_BOLD}`;
        for (const ln of fit.lines) {
            ctx.fillText(ln, innerX, cy);
            cy += fit.lineH;
        }
    }

    // Métadonnées
    cy += metaLines.length ? 4 : 0;
    ctx.font = `10px ${FONT}`;
    for (const m of metaLines) {
        ctx.fillStyle = m.color;
        ctx.fillText(m.text, innerX, cy);
        cy += 13;
    }

    ctx.restore();
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
