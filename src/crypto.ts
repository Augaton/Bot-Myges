import * as crypto from 'crypto';
import * as dotenv from 'dotenv';
dotenv.config();

const algorithm = 'aes-256-cbc';
const key = process.env.ENCRYPTION_KEY;

if (!key || key.length !== 32) {
    console.error("❌ ERREUR CRITIQUE : La variable ENCRYPTION_KEY dans .env doit faire exactement 32 caractères !");
    process.exit(1);
}

// Fonction pour chiffrer
export function encrypt(text: string) {
    const iv = crypto.randomBytes(16); // Vecteur d'initialisation aléatoire
    const cipher = crypto.createCipheriv(algorithm, Buffer.from(key!), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return { iv: iv.toString('hex'), content: encrypted.toString('hex') };
}

// Fonction pour déchiffrer
export function decrypt(hash: { iv: string, content: string }) {
    const iv = Buffer.from(hash.iv, 'hex');
    const encryptedText = Buffer.from(hash.content, 'hex');
    const decipher = crypto.createDecipheriv(algorithm, Buffer.from(key!), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
}