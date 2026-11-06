// Téléchargement des photos MyGes (trombinoscope, professeurs).
import { readBounded } from '../myges/services/base';
import { fetchTrusted, isTrustedMygesUrl } from '../myges/trusted';
import { logError } from './logger';

// Une photo de trombinoscope pèse quelques centaines de Ko. Ces limites gardent
// la mémoire d'une navigation bornée, quoi que réponde le serveur.
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const MAX_CACHED_PHOTOS = 30;

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
        const load = (headers: Record<string, string>) => fetchTrusted(photoUrl, { headers, signal: AbortSignal.timeout(10_000) });
        let response = await load({});
        if (!response.ok) {
            // Corps non lu = connexion retenue : on le libère avant de rejouer.
            await response.body?.cancel().catch(() => {});
            response = await load({ Authorization: `${token.token_type} ${token.access_token}` });
        }
        if (response.ok) buffer = await readBounded(response, MAX_PHOTO_BYTES);
        else await response.body?.cancel().catch(() => {});
    } catch (e) {
        logError('PHOTO', 'Téléchargement de la photo impossible :', e);
    }

    return remember(buffer);
}
