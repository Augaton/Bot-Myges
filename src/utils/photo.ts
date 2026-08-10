// Téléchargement des photos MyGes (trombinoscope, professeurs).
import { logError } from './logger';

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

    if (!isTrustedMygesUrl(photoUrl)) {
        logError('PHOTO', `URL non fiable ignorée, token non transmis : ${photoUrl}`);
        cache.set(photoUrl, null);
        return null;
    }

    try {
        // On tente d'abord sans authentification, puis avec le token si besoin.
        // Délai maximal : une photo qui ne vient pas ne doit pas bloquer la
        // navigation dans le trombinoscope.
        let response = await fetch(photoUrl, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) {
            response = await fetch(photoUrl, {
                headers: { Authorization: `${token.token_type} ${token.access_token}` },
                signal: AbortSignal.timeout(10_000),
            });
        }
        if (response.ok) buffer = Buffer.from(await response.arrayBuffer());
    } catch (e) {
        logError('PHOTO', 'Téléchargement de la photo impossible :', e);
    }

    cache.set(photoUrl, buffer);
    return buffer;
}
