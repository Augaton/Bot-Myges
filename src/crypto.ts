import * as crypto from 'crypto';
import * as dotenv from 'dotenv';
dotenv.config();

// AES-256-GCM : chiffrement authentifié (intègre un tag d'intégrité), plus
// robuste que CBC qui est malléable.
const ALGORITHM = 'aes-256-gcm';
const LEGACY_ALGORITHM = 'aes-256-cbc'; // pour déchiffrer les anciennes données
const key = process.env.ENCRYPTION_KEY;

if (!key || key.length !== 32) {
    console.error("❌ ERREUR CRITIQUE : La variable ENCRYPTION_KEY dans .env doit faire exactement 32 caractères !");
    process.exit(1);
}

export interface EncryptedData {
    iv: string;
    content: string;
    tag?: string; // présent uniquement pour le format GCM (nouveau)
}

// Chiffrement (GCM)
export function encrypt(text: string): EncryptedData {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(key!), iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
        iv: iv.toString('hex'),
        content: encrypted.toString('hex'),
        tag: tag.toString('hex'),
    };
}

// Déchiffrement : GCM si un tag est présent, sinon repli sur l'ancien CBC.
export function decrypt(hash: EncryptedData): string {
    const iv = Buffer.from(hash.iv, 'hex');
    const encryptedText = Buffer.from(hash.content, 'hex');

    if (hash.tag) {
        const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(key!), iv);
        decipher.setAuthTag(Buffer.from(hash.tag, 'hex'));
        return Buffer.concat([decipher.update(encryptedText), decipher.final()]).toString('utf8');
    }

    // Format hérité (aes-256-cbc, sans tag)
    const decipher = crypto.createDecipheriv(LEGACY_ALGORITHM, Buffer.from(key!), iv);
    return Buffer.concat([decipher.update(encryptedText), decipher.final()]).toString('utf8');
}
