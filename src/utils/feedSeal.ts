// Abonnement d'agenda : le fichier que prépare le bot et que sert le panel. Il n'est
// lisible qu'avec le secret du lien : le fichier seul ne donne rien, et le panel n'a
// jamais besoin de la clé de chiffrement du bot. Uniquement node:crypto, à dessein.
import * as crypto from 'node:crypto';

/** Secret d'un lien : 32 octets aléatoires, en base64url (43 caractères). */
export const FEED_SECRET = /^[A-Za-z0-9_-]{43}$/;
export const newFeedSecret = () => crypto.randomBytes(32).toString('base64url');

/** Nom du fichier : l'empreinte du secret, jamais le secret lui-même. */
export const feedId = (secret: string) => crypto.createHash('sha256').update(secret).digest('hex');
const feedKey = (secret: string) => Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), 'myges-panel/agenda', 32));

export interface SealedFeed {
    iv: string;
    content: string;
    tag: string;
    updatedAt: number;
}

export function sealFeed(secret: string, ics: string, now = Date.now()): SealedFeed {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', feedKey(secret), iv);
    cipher.setAAD(Buffer.from(feedId(secret))); // un fichier recopié sous un autre nom ne s'ouvre pas
    const content = Buffer.concat([cipher.update(ics, 'utf8'), cipher.final()]);
    return { iv: iv.toString('hex'), content: content.toString('hex'), tag: cipher.getAuthTag().toString('hex'), updatedAt: now };
}

/** Le calendrier en clair ; lève une erreur si le secret ne correspond pas ou si le fichier a été modifié. */
export function openFeed(secret: string, sealed: SealedFeed): string {
    const decipher = crypto.createDecipheriv('aes-256-gcm', feedKey(secret), Buffer.from(sealed.iv, 'hex'), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(feedId(secret)));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(sealed.content, 'hex')), decipher.final()]).toString('utf8');
}
