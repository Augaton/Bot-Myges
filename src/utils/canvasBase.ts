// Socle graphique partagé par les rendus canvas (agenda, notes) :
// polices embarquées, palette dark-mode Discord et helpers de dessin/texte.
// Utilise @napi-rs/canvas : binaires précompilés, aucun build natif requis.
import { createCanvas, GlobalFonts, SKRSContext2D } from '@napi-rs/canvas';
import * as path from 'node:path';
import { logError } from './logger';

// --- POLICES EMBARQUÉES ---
// On enregistre DejaVu Sans (bundlée dans le repo) pour un rendu identique
// quel que soit le serveur, même sans polices système installées.
const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
let fontsReady = false;

export function ensureFonts() {
    if (fontsReady) return;
    try {
        // Le registre de polices est natif : il peut déjà contenir nos polices si
        // un autre thread (worker de rendu) les a enregistrées. Pas de doublon.
        if (!GlobalFonts.has(FONT)) GlobalFonts.registerFromPath(path.join(FONT_DIR, 'DejaVuSans.ttf'), FONT);
        if (!GlobalFonts.has(FONT_BOLD)) GlobalFonts.registerFromPath(path.join(FONT_DIR, 'DejaVuSans-Bold.ttf'), FONT_BOLD);
    } catch (e) {
        logError('CANVAS', 'Polices non chargées, fallback système :', e);
    }
    fontsReady = true;
}

export const FONT = 'AgendaSans';
export const FONT_BOLD = 'AgendaSansBold';

// --- THÈME (aligné sur le dark mode Discord) ---
export const COL = {
    bg: '#1e1f22',
    panel: '#2b2d31',
    panelAlt: '#232428',
    grid: '#3a3c41',
    track: '#3a3c41',
    text: '#ffffff',
    muted: '#b5bac1',
    faint: '#80848e',
    now: '#f23f43',
    accent: '#5865f2',
};

export function hexToRgba(hex: string, a: number): string {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// Contexte jetable servant uniquement à mesurer du texte hors rendu.
let measureCtx: SKRSContext2D | null = null;
export function measureContext(): SKRSContext2D {
    if (!measureCtx) measureCtx = createCanvas(10, 10).getContext('2d');
    return measureCtx;
}

// Rectangle arrondi
export function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
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
export function wrapAt(ctx: SKRSContext2D, text: string, maxW: number): string[] {
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

// Tronque un texte sur une seule ligne (police courante déjà settée).
export function ellipsize(ctx: SKRSContext2D, text: string, maxW: number): string {
    if (ctx.measureText(text).width <= maxW) return text;
    let cur = text;
    while (cur.length > 1 && ctx.measureText(cur + '…').width > maxW) cur = cur.slice(0, -1);
    return cur + '…';
}

// Choisit la plus grande taille de police (entre min et max) pour que `text`
// tienne entièrement dans (maxW x maxH). Ellipse en dernier recours.
export function fitText(
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
        lines[maxLines - 1] = ellipsize(ctx, lines[maxLines - 1], maxW);
    }
    return { lines, size, lineH };
}
