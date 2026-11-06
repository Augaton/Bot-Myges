// Requêtes vers MyGes : seules des adresses de MyGes, en HTTPS, sont suivies.
import { MyGesError } from './errors';

const MAX_REDIRECTS = 3;

/** Vérifie qu'une URL pointe bien vers MyGes avant d'y envoyer quoi que ce soit. */
export function isTrustedMygesUrl(url: string): boolean {
    try {
        const u = new URL(url);
        return u.protocol === 'https:' && (u.hostname === 'kordis.fr' || u.hostname.endsWith('.kordis.fr'));
    } catch {
        return false;
    }
}

type TrustedInit = Omit<RequestInit, 'headers'> & { headers: Record<string, string> };

/**
 * Comme fetch, mais chaque redirection est contrôlée : une réponse ne doit pas
 * pouvoir mener le serveur vers une adresse interne, dont le contenu serait
 * ensuite remis à l'utilisateur. Le token ne suit pas vers un autre hôte.
 */
export async function fetchTrusted(url: string, init: TrustedInit): Promise<Response> {
    let next = url;
    let headers: Record<string, string> = init.headers;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const response = await fetch(next, { ...init, headers, redirect: 'manual' });
        const location = response.headers.get('location');
        if (response.status < 300 || response.status >= 400 || !location) return response;
        await response.body?.cancel().catch(() => {});

        const target = new URL(location, next);
        if (!isTrustedMygesUrl(target.href)) break;
        if (target.origin !== new URL(next).origin) {
            const { Authorization: _token, ...others } = headers;
            headers = others;
        }
        next = target.href;
    }
    throw new MyGesError(502, 'Redirection refusée : elle quitte MyGes ou se répète trop.');
}
