// Téléchargement des photos MyGes (trombinoscope, professeurs).
import { readBounded } from '../myges/services/base';
import { logError } from './logger';

// Une photo de trombinoscope pèse quelques centaines de Ko. Ces limites gardent
// la mémoire d'une navigation bornée, quoi que réponde le serveur.
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const MAX_CACHED_PHOTOS = 30;
const MAX_PHOTO_REDIRECTS = 3;

/**
 * Vérifie que l'URL pointe bien vers MyGes avant d'y envoyer quoi que ce soit.
 * Les URLs de photos viennent de la réponse de l'API : sans ce contrôle, une
 * réponse malveillante ferait fuiter le token MyGes de l'utilisateur vers un
 * hôte tiers (le token est envoyé en en-tête Authorization).
 */
function isTrustedMygesUrl(url: string): boolean {
    try {
        const u = new URL(url);
        if (u.protocol !== 'https:') return false;
        return u.hostname === 'kordis.fr' || u.hostname.endsWith('.kordis.fr');
    } catch {
        return false; // URL invalide
    }
}

/**
 * Comme fetch, mais chaque redirection est contrôlée : l'URL de départ a beau être
 * fiable, elle ne doit pas pouvoir mener le bot vers une adresse interne.
 * Renvoie null si une étape quitte MyGes.
 */
async function fetchTrusted(url: string, headers: Record<string, string>): Promise<Response | null> {
    let next = url;
    for (let hop = 0; hop <= MAX_PHOTO_REDIRECTS; hop++) {
        if (!isTrustedMygesUrl(next)) break;
        const response = await fetch(next, { headers, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
        const location = response.headers.get('location');
        if (response.status < 300 || response.status >= 400 || !location) return response;
        await response.body?.cancel().catch(() => {});
        next = new URL(location, next).href;
    }
    logError('PHOTO', 'Redirection refusée : elle quitte MyGes ou se répète trop.');
    return null;
}

/**
 * Récupère la photo et renvoie son contenu, ou null si indisponible.
 *
 * @param cache Cache fourni par l'appelant (une Map par exécution de commande) :
 *              évite de re-télécharger la même photo à chaque clic de navigation.
 */
export async function fetchPhotoBuffer(
    photoUrl: string,
    token: { token_type: string; access_token: string },
    cache: Map<string, Buffer | null>
): Promise<Buffer | null> {
    // Déjà tenté durant cette navigation (succès comme échec) : on ne refait rien.
    const cached = cache.get(photoUrl);
    if (cached !== undefined) return cached;

    let buffer: Buffer | null = null;
    const remember = (value: Buffer | null) => {
        cache.set(photoUrl, value);
        if (cache.size > MAX_CACHED_PHOTOS) cache.delete(cache.keys().next().value!);
        return value;
    };

    if (!isTrustedMygesUrl(photoUrl)) {
        logError('PHOTO', `URL non fiable ignorée, token non transmis : ${photoUrl}`);
        return remember(null);
    }

    try {
        // On tente d'abord sans authentification, puis avec le token si besoin.
        // Délai maximal : une photo qui ne vient pas ne doit pas bloquer la
        // navigation dans le trombinoscope.
        let response = await fetchTrusted(photoUrl, {});
        if (response && !response.ok) {
            // Corps non lu = connexion retenue : on le libère avant de rejouer.
            await response.body?.cancel().catch(() => {});
            response = await fetchTrusted(photoUrl, { Authorization: `${token.token_type} ${token.access_token}` });
        }
        if (response?.ok) buffer = await readBounded(response, MAX_PHOTO_BYTES);
        else await response?.body?.cancel().catch(() => {});
    } catch (e) {
        logError('PHOTO', 'Téléchargement de la photo impossible :', e);
    }

    return remember(buffer);
}
