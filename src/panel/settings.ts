// Réglages du panel. Seules les variables PANEL_* sont lues dans le .env : ce
// processus n'a pas à avoir en mémoire le token Discord ni la clé de chiffrement.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseEnv } from 'node:util';

export interface PanelSettings {
    host: string;
    port: number;
    trustProxy: boolean;
    tls?: { cert: string; key: string };
}

export function readSettings(envFile = path.resolve(__dirname, '..', '..', '.env')): PanelSettings {
    let file: Record<string, string | undefined> = {};
    try {
        file = parseEnv(fs.readFileSync(envFile, 'utf-8'));
    } catch (e: any) {
        if (e?.code !== 'ENOENT') throw e;
    }
    const read = (name: string) => process.env[name] ?? file[name];
    const cert = read('PANEL_TLS_CERT');
    const key = read('PANEL_TLS_KEY');
    return {
        // Local par défaut : un mot de passe ne doit pas circuler sans HTTPS.
        host: read('PANEL_HOST') || '127.0.0.1',
        port: Number(read('PANEL_PORT')) || 3000,
        trustProxy: read('PANEL_TRUST_PROXY') === '1',
        tls: cert && key ? { cert, key } : undefined,
    };
}
