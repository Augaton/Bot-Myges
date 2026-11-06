// Sessions du panel, en mémoire vive uniquement. Le mot de passe n'y figure pas :
// il sert une fois à obtenir le token MyGes, puis il est oublié. Quand le token
// expire, l'étudiant se reconnecte.
import * as crypto from 'node:crypto';
import { forgetUser } from '../core/mygesData';
import type { GesAuthenticationToken } from '../myges/types/auth';

const IDLE_MS = 30 * 60_000;
const MAX_AGE_MS = 12 * 3_600_000;
const MAX_SESSIONS = 2_000;
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
}

// Seule l'empreinte du cookie est gardée : une fuite de la mémoire (trace, vidage)
// ne donnerait pas de cookie utilisable.
const digest = (cookie: string) => crypto.createHash('sha256').update(cookie).digest('hex');

export class Sessions {
    private readonly map = new Map<string, Session>();

    /** Ouvre une session ; renvoie la valeur du cookie, à ne transmettre qu'au navigateur. */
    open(token: GesAuthenticationToken, name: string, account: string, uid: number | null): { cookie: string; session: Session } {
        this.sweep();
        // Une Map garde l'ordre d'insertion : la première session du compte est la plus ancienne.
        const own = [...this.map].filter(([, s]) => s.account === account).map(([id]) => id);
        while (own.length >= MAX_PER_ACCOUNT) this.remove(own.shift()!);
        // Plein : on ferme la moins récemment utilisée, jamais une session active.
        if (this.map.size >= MAX_SESSIONS) this.remove(this.leastRecentlyUsed());

        const now = Date.now();
        const cookie = crypto.randomBytes(32).toString('base64url');
        const session: Session = {
            key: `panel-${crypto.randomUUID()}`,
            account,
            uid,
            token,
            name,
            expiresAt: Math.min(token.expires_at ?? Infinity, now + MAX_AGE_MS),
            idleUntil: now + IDLE_MS,
        };
        this.map.set(digest(cookie), session);
        return { cookie, session };
    }

    get(cookie: string | undefined): Session | null {
        if (!cookie) return null;
        const id = digest(cookie);
        const session = this.map.get(id);
        if (!session) return null;
        const now = Date.now();
        if (now >= session.expiresAt || now >= session.idleUntil) {
            this.remove(id);
            return null;
        }
        session.idleUntil = now + IDLE_MS;
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

    private leastRecentlyUsed(): string {
        let found = '';
        let oldest = Infinity;
        for (const [id, session] of this.map) {
            if (session.idleUntil < oldest) {
                oldest = session.idleUntil;
                found = id;
            }
        }
        return found;
    }

    private remove(id: string) {
        const session = this.map.get(id);
        if (session) forgetUser(session.key);
        this.map.delete(id);
    }

    private sweep() {
        const now = Date.now();
        for (const [id, session] of this.map) {
            if (now >= session.expiresAt || now >= session.idleUntil) this.remove(id);
        }
    }
}
