// Lien « Ouvrir le panel » de /panel : l'étudiant connecté au bot entre dans le panel
// sans retaper son mot de passe. Le bot y dépose un ticket, le panel le retire.
//
// Même principe que l'abonnement d'agenda (voir feedSeal.ts) : le fichier porte le
// nom de l'empreinte du secret et n'est lisible qu'avec le secret lui-même. Le panel
// n'a donc jamais la clé de chiffrement du bot. Le secret voyage dans le fragment de
// l'adresse (#connexion=…) : le navigateur ne l'envoie pas au serveur, il n'apparaît
// dans aucun journal, et l'aperçu de lien de Discord ne peut pas consommer le ticket.
//
// Un ticket sert une seule fois, dix minutes au plus, et un étudiant n'en a qu'un en
// attente. Uniquement des modules de Node, à dessein : le panel l'importe aussi.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GesAuthenticationToken } from '../myges/types/auth';

export const TICKET_TTL_MS = 10 * 60_000;
/** Secret d'un ticket : 32 octets aléatoires, en base64url (43 caractères). */
export const TICKET_SECRET = /^[A-Za-z0-9_-]{43}$/;

export interface Ticket {
    token: GesAuthenticationToken;
    /** Identifiant MyGES : le panel en tire le compte, comme à une connexion par mot de passe. */
    username: string;
    expiresAt: number;
}

interface SealedTicket {
    iv: string;
    content: string;
    tag: string;
    expiresAt: number;
}

const ticketId = (secret: string) => crypto.createHash('sha256').update(`connexion:${secret}`).digest('hex');
const ticketKey = (secret: string) => Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), 'myges-panel/connexion', 32));
// L'échéance, lisible pour le ménage, est aussi authentifiée : la repousser à la main
// rend le ticket illisible.
const aad = (secret: string, expiresAt: number) => Buffer.from(`${ticketId(secret)}:${expiresAt}`);
const fileOf = (dir: string, secret: string) => path.join(dir, `connexion-${ticketId(secret)}.json`);
// Le ménage ne touche qu'aux fichiers qui portent ce nom : un dossier mal réglé (celui
// des abonnements, la racine du projet) ne perd jamais rien d'autre.
const TICKET_FILE = /^connexion-[0-9a-f]{64}\.json(\.tmp)?$/;

function seal(secret: string, ticket: Ticket): SealedTicket {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', ticketKey(secret), iv);
    cipher.setAAD(aad(secret, ticket.expiresAt));
    const { token_type, access_token, expires_at } = ticket.token;
    const secretPart = JSON.stringify({ token: { token_type, access_token, expires_at }, username: ticket.username });
    const content = Buffer.concat([cipher.update(secretPart, 'utf8'), cipher.final()]);
    return { iv: iv.toString('hex'), content: content.toString('hex'), tag: cipher.getAuthTag().toString('hex'), expiresAt: ticket.expiresAt };
}

function unseal(secret: string, sealed: SealedTicket): Ticket {
    const decipher = crypto.createDecipheriv('aes-256-gcm', ticketKey(secret), Buffer.from(sealed.iv, 'hex'), { authTagLength: 16 });
    decipher.setAAD(aad(secret, sealed.expiresAt));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'hex'));
    const { token, username } = JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.content, 'hex')), decipher.final()]).toString('utf8'));
    return { token, username, expiresAt: sealed.expiresAt };
}

// --- Côté bot ---

// Ticket en attente de chaque étudiant (fichier). En mémoire seulement : après un
// redémarrage, les anciens expirent d'eux-mêmes.
const pending = new Map<string, string>();

/** Retire le ticket en attente de cet étudiant (nouveau lien, /logout). */
export function dropTicket(userId: string) {
    const file = pending.get(userId);
    if (!file) return;
    pending.delete(userId);
    fs.rmSync(file, { force: true });
}

/** Supprime les tickets échus ou illisibles, et rien d'autre. */
function sweep(dir: string, now: number) {
    for (const name of fs.readdirSync(dir)) {
        if (!TICKET_FILE.test(name)) continue;
        const file = path.join(dir, name);
        try {
            if (JSON.parse(fs.readFileSync(file, 'utf-8')).expiresAt > now) continue;
        } catch {
            /* fichier illisible : supprimé */
        }
        fs.rmSync(file, { force: true });
    }
}

/** Dépose un ticket pour cet étudiant ; renvoie son secret, à ne donner qu'à lui. */
export function createTicket(dir: string, userId: string, token: GesAuthenticationToken, username: string, now = Date.now()): string {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    sweep(dir, now);
    dropTicket(userId);
    const secret = crypto.randomBytes(32).toString('base64url');
    const file = fileOf(dir, secret);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(seal(secret, { token, username, expiresAt: now + TICKET_TTL_MS })), { mode: 0o600 });
    fs.renameSync(tmp, file);
    pending.set(userId, file);
    return secret;
}

// --- Côté panel ---

/** Retire le ticket et le renvoie, ou null s'il est inconnu, déjà servi ou échu. */
export async function takeTicket(dir: string, secret: string, now = Date.now()): Promise<Ticket | null> {
    if (!TICKET_SECRET.test(secret)) return null;
    const file = fileOf(dir, secret);
    let sealed: SealedTicket;
    try {
        sealed = JSON.parse(await fs.promises.readFile(file, 'utf-8'));
        // Usage unique : de deux demandes simultanées, seule celle qui le supprime passe.
        await fs.promises.unlink(file);
    } catch {
        return null;
    }
    try {
        const ticket = unseal(secret, sealed);
        return ticket.expiresAt > now ? ticket : null;
    } catch {
        return null;
    }
}
