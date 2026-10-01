import * as crypto from 'node:crypto';
import { EXIT_CONFIG } from './config'; // charge aussi le .env

// AES-256-GCM : chiffrement authentifié (intègre un tag d'intégrité), plus
// robuste que CBC qui est malléable.
const ALGORITHM = 'aes-256-gcm';
const LEGACY_ALGORITHM = 'aes-256-cbc'; // pour déchiffrer les très anciennes données
// IV de 12 octets : taille standard pour GCM. Les données chiffrées avec un IV
// de 16 octets restent lisibles (la taille est relue depuis l'IV stocké).
const GCM_IV_BYTES = 12;
const SECRET = process.env.ENCRYPTION_KEY;

// On compte des octets, pas des caractères : une clé avec un accent ferait
// 32 caractères mais 33 octets.
if (!SECRET || Buffer.byteLength(SECRET, 'utf8') < 32) {
    console.error('❌ ERREUR CRITIQUE : ENCRYPTION_KEY (.env) doit faire au moins 32 caractères !');
    process.exit(EXIT_CONFIG);
}

/**
 * Paramètres de dérivation de clé, enregistrés avec les données (le sel n'a
 * pas à être secret). La clé de chiffrement n'est plus ENCRYPTION_KEY telle
 * quelle mais scrypt(ENCRYPTION_KEY, sel) : retrouver une clé faible à partir
 * d'un saved_data.json volé devient très coûteux, et le sel propre à chaque
 * installation empêche tout précalcul.
 */
export interface KdfParams {
    algo: 'scrypt';
    salt: string;
    N: number;
    r: number;
    p: number;
}

export interface EncryptedData {
    v?: 2; // 2 : clé dérivée par scrypt. Absent : ancien format (clé brute).
    iv: string;
    content: string;
    tag?: string; // présent pour GCM ; absent pour l'ancien format CBC
}

/** Nouveaux paramètres : N = 2^16, r = 8 → ~64 Mo et ~0,2 s, une seule fois au démarrage. */
export function createKdfParams(): KdfParams {
    return { algo: 'scrypt', salt: crypto.randomBytes(16).toString('hex'), N: 2 ** 16, r: 8, p: 1 };
}

let derivedKey: Buffer | null = null;
let fingerprintKey: Buffer | null = null;

/** Calcule la clé dérivée. Appelé une fois, au chargement des données (store). */
export function useKdf(params: KdfParams) {
    if (params.algo !== 'scrypt') throw new Error(`Dérivation de clé inconnue : ${params.algo}`);
    derivedKey = crypto.scryptSync(SECRET!, Buffer.from(params.salt, 'hex'), 32, {
        N: params.N,
        r: params.r,
        p: params.p,
        maxmem: 256 * params.N * params.r, // scrypt en exige 128·N·r
    });
    // Sous-clé distincte pour les empreintes : une clé ne sert qu'à un usage.
    fingerprintKey = Buffer.from(crypto.hkdfSync('sha256', derivedKey, Buffer.alloc(0), 'myges-bot/fingerprint', 32));
}

function currentKey(): Buffer {
    if (!derivedKey) throw new Error('Clé de chiffrement non initialisée (useKdf).');
    return derivedKey;
}

// Ancien format : ENCRYPTION_KEY utilisée telle quelle, d'exactement 32 octets.
function legacyKey(): Buffer {
    const key = Buffer.from(SECRET!, 'utf8');
    if (key.length !== 32) throw new Error("Données à l'ancien format : ENCRYPTION_KEY doit faire exactement 32 caractères pour les relire.");
    return key;
}

/** Vrai si la donnée utilise encore l'ancien format (à migrer). */
export function isLegacy(hash: EncryptedData): boolean {
    return hash.v !== 2;
}

// Chiffrement : toujours au format courant (GCM + clé dérivée).
export function encrypt(text: string): EncryptedData {
    const iv = crypto.randomBytes(GCM_IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, currentKey(), iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return {
        v: 2,
        iv: iv.toString('hex'),
        content: encrypted.toString('hex'),
        tag: cipher.getAuthTag().toString('hex'),
    };
}

// Déchiffrement : format courant, ancien GCM (clé brute) ou très ancien CBC.
export function decrypt(hash: EncryptedData): string {
    const iv = Buffer.from(hash.iv, 'hex');
    const encryptedText = Buffer.from(hash.content, 'hex');

    if (hash.tag) {
        const key = hash.v === 2 ? currentKey() : legacyKey();
        // Longueur de tag imposée : un tag tronqué affaiblirait l'authentification.
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: 16 });
        decipher.setAuthTag(Buffer.from(hash.tag, 'hex'));
        return Buffer.concat([decipher.update(encryptedText), decipher.final()]).toString('utf8');
    }

    const decipher = crypto.createDecipheriv(LEGACY_ALGORITHM, legacyKey(), iv);
    return Buffer.concat([decipher.update(encryptedText), decipher.final()]).toString('utf8');
}

/**
 * Empreinte (HMAC) d'une donnée qu'on veut reconnaître sans la stocker en
 * clair (ex : notes déjà signalées). Un simple hash ne suffirait pas : une note
 * sur 20 se retrouve en quelques essais.
 */
export function fingerprint(text: string): string {
    if (!fingerprintKey) throw new Error('Clé de chiffrement non initialisée (useKdf).');
    return crypto.createHmac('sha256', fingerprintKey).update(text).digest('hex').slice(0, 24);
}
