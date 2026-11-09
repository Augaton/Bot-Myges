// Sessions du panel. Le mot de passe n'y figure jamais : il sert une fois à obtenir le
// token MyGes, puis il est oublié. Quand le token expire, l'étudiant se reconnecte.
//
// Une session ordinaire ne vit qu'en mémoire. Celle d'un étudiant qui a coché « Rester
// connecté » est aussi écrite sur disque, pour survivre à un redémarrage, chiffrée avec
// une clé tirée de son cookie. Le serveur ne garde que l'empreinte de ce cookie : un
// fichier volé, seul, ne donne ni token, ni nom, ni identifiant. Aucune clé à gérer, et
// le panel reste sans la clé de chiffrement du bot.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { forgetUser } from '../core/mygesData';
import { log, logError } from '../utils/logger';
import type { GesAuthenticationToken } from '../myges/types/auth';

const IDLE_MS = 30 * 60_000;
const MAX_AGE_MS = 12 * 3_600_000;
// Plafond de « Rester connecté » : en pratique, le token MyGes expire avant (7 jours environ).
const MAX_REMEMBERED_MS = 30 * 86_400_000;
const MAX_SESSIONS = 2_000;
const MAX_SEALED = 5_000;
const MAX_PER_ACCOUNT = 3;

export interface Session {
    /** Clé des données en cache : sans rapport avec le cookie, jamais transmise. */
    key: string;
    /** Compte MyGes, sous forme canonique : les limites valent par personne. */
    account: string;
    /** Identifiant MyGes de l'étudiant : c'est lui qui désigne son groupe de projet. */
    uid: number | null;
    token: GesAuthenticationToken;
    name: string;
    expiresAt: number;
    idleUntil: number;
    remember: boolean;
}

/** Session sur disque : seule l'échéance est lisible sans le cookie. */
interface Sealed {
    iv: string;
    content: string;
    tag: string;
    expiresAt: number;
}

// Seule l'empreinte du cookie est gardée : une fuite de la mémoire (trace, vidage)
// ou du fichier ne donnerait pas de cookie utilisable.
const digest = (cookie: string) => crypto.createHash('sha256').update(cookie).digest('hex');
const sealKey = (cookie: string) => Buffer.from(crypto.hkdfSync('sha256', cookie, Buffer.alloc(0), 'myges-panel/session', 32));

function seal(cookie: string, id: string, session: Session): Sealed {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', sealKey(cookie), iv);
    cipher.setAAD(Buffer.from(id)); // une entrée ne peut pas être recopiée sous une autre empreinte
    const { token_type, access_token, expires_at } = session.token;
    const secret = JSON.stringify({ token: { token_type, access_token, expires_at }, name: session.name, account: session.account, uid: session.uid });
    const content = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return { iv: iv.toString('hex'), content: content.toString('hex'), tag: cipher.getAuthTag().toString('hex'), expiresAt: session.expiresAt };
}

function unseal(cookie: string, id: string, sealed: Sealed): Session {
    const decipher = crypto.createDecipheriv('aes-256-gcm', sealKey(cookie), Buffer.from(sealed.iv, 'hex'), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(id));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'hex'));
    const secret = JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.content, 'hex')), decipher.final()]).toString('utf8'));
    return {
        key: `panel-${crypto.randomUUID()}`,
        account: secret.account,
        uid: secret.uid,
        token: secret.token,
        name: secret.name,
        expiresAt: sealed.expiresAt,
        idleUntil: sealed.expiresAt,
        remember: true,
    };
}

export class Sessions {
    private readonly map = new Map<string, Session>();
    private readonly sealed = new Map<string, Sealed>();
    private readonly file?: string;

    /** `file` : où garder les sessions « Rester connecté ». Sans lui, tout reste en mémoire. */
    constructor(file?: string) {
        this.file = file;
        if (file) this.load(file);
    }

    /** Ouvre une session ; renvoie la valeur du cookie, à ne transmettre qu'au navigateur. */
    open(token: GesAuthenticationToken, name: string, account: string, uid: number | null, remember = false): { cookie: string; session: Session } {
        this.sweep();
        this.makeRoom(account);

        const now = Date.now();
        const keep = remember && !!this.file;
        const expiresAt = Math.min(token.expires_at ?? Infinity, now + (keep ? MAX_REMEMBERED_MS : MAX_AGE_MS));
        const cookie = crypto.randomBytes(32).toString('base64url');
        const session: Session = {
            key: `panel-${crypto.randomUUID()}`,
            account,
            uid,
            token,
            name,
            expiresAt,
            idleUntil: keep ? expiresAt : now + IDLE_MS,
            remember: keep,
        };
        const id = digest(cookie);
        this.map.set(id, session);
        if (keep) {
            this.sealed.set(id, seal(cookie, id, session));
            this.trimSealed();
            this.save();
        }
        return { cookie, session };
    }

    get(cookie: string | undefined): Session | null {
        if (!cookie) return null;
        const id = digest(cookie);
        const session = this.map.get(id) ?? this.restore(cookie, id);
        if (!session) return null;
        const now = Date.now();
        if (now >= session.expiresAt || now >= session.idleUntil) {
            this.remove(id);
            return null;
        }
        if (!session.remember) session.idleUntil = now + IDLE_MS;
        return session;
    }

    close(cookie: string | undefined) {
        if (cookie) this.remove(digest(cookie));
    }

    /** Ferme une session dont MyGes a refusé le token. */
    drop(session: Session) {
        for (const [id, entry] of this.map) {
            if (entry === session) this.remove(id);
        }
    }

    /** Session gardée sur disque, déchiffrée grâce au cookie qui vient de se présenter. */
    private restore(cookie: string, id: string): Session | null {
        const sealed = this.sealed.get(id);
        if (!sealed) return null;
        try {
            const session = unseal(cookie, id, sealed);
            // Le fichier ne dit pas à quel compte une entrée appartient : le plafond par
            // compte ne peut s'appliquer qu'ici, quand le cookie permet de le lire.
            this.makeRoom(session.account);
            this.map.set(id, session);
            return session;
        } catch {
            this.remove(id); // entrée altérée : inutilisable
            return null;
        }
    }

    private makeRoom(account: string) {
        // Une Map garde l'ordre d'insertion : la première session du compte est la plus ancienne.
        const own = [...this.map].filter(([, s]) => s.account === account).map(([id]) => id);
        while (own.length >= MAX_PER_ACCOUNT) this.remove(own.shift()!);
        if (this.map.size >= MAX_SESSIONS) this.unload(this.leastRecentlyUsed());
    }

    /** Mémoire pleine : la session à décharger, jamais une session active si on peut l'éviter. */
    private leastRecentlyUsed(): string {
        let found = '';
        let oldest = Infinity;
        for (const [id, session] of this.map) {
            // Gardée sur disque, elle reviendra à sa prochaine requête, sans déconnexion.
            if (this.sealed.has(id)) return id;
            if (session.idleUntil < oldest) {
                oldest = session.idleUntil;
                found = id;
            }
        }
        return found;
    }

    /** Libère la mémoire, sans déconnecter un étudiant qui a demandé à rester connecté. */
    private unload(id: string) {
        const session = this.map.get(id);
        if (session) forgetUser(session.key);
        this.map.delete(id);
    }

    private remove(id: string) {
        this.unload(id);
        if (this.sealed.delete(id)) this.save();
    }

    private sweep() {
        const now = Date.now();
        for (const [id, session] of this.map) {
            if (now >= session.expiresAt || now >= session.idleUntil) this.unload(id);
        }
        let changed = false;
        for (const [id, sealed] of this.sealed) {
            if (now >= sealed.expiresAt) changed = this.sealed.delete(id) || changed;
        }
        if (changed) this.save();
    }

    private trimSealed() {
        while (this.sealed.size > MAX_SEALED) {
            const [soonest] = [...this.sealed].sort(([, a], [, b]) => a.expiresAt - b.expiresAt)[0];
            this.sealed.delete(soonest);
        }
    }

    private load(file: string) {
        try {
            const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
            const now = Date.now();
            for (const [id, entry] of Object.entries<any>(saved?.sessions ?? {})) {
                const usable = /^[0-9a-f]{64}$/.test(id) && typeof entry?.iv === 'string' && typeof entry?.content === 'string'
                    && typeof entry?.tag === 'string' && Number(entry?.expiresAt) > now;
                if (usable) this.sealed.set(id, { iv: entry.iv, content: entry.content, tag: entry.tag, expiresAt: Number(entry.expiresAt) });
            }
            fs.chmodSync(file, 0o600);
            log('PANEL', `${this.sealed.size} session(s) « Rester connecté » conservée(s).`);
        } catch (e: any) {
            // Illisible : au pire, les étudiants se reconnectent. Le panel démarre quand même.
            if (e?.code !== 'ENOENT') logError('PANEL', `Sessions de ${file} illisibles, ignorées :`, e?.message);
        }
    }

    /** Écriture atomique : jamais de fichier à moitié écrit, jamais lisible par un autre compte. */
    private save() {
        if (!this.file) return;
        const tmp = `${this.file}.tmp`;
        try {
            fs.writeFileSync(tmp, JSON.stringify({ version: 1, sessions: Object.fromEntries(this.sealed) }), { mode: 0o600 });
            fs.renameSync(tmp, this.file);
            fs.chmodSync(this.file, 0o600);
        } catch (e: any) {
            // Sessions toujours valables en mémoire : seul un redémarrage les perdrait.
            logError('PANEL', `Écriture des sessions impossible (${e?.code ?? 'erreur'}).`);
        }
    }
}
