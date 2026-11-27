// Envoi de messages privés (alertes de notes, rappels de rendus).
import { Client, MessageCreateOptions, RESTJSONErrorCodes } from 'discord.js';
import { log, logError } from './logger';

/**
 * Issue d'un envoi :
 *  • `closed` : l'utilisateur ne peut pas recevoir de MP du bot (MP fermés, plus aucun
 *    serveur en commun, compte supprimé) ;
 *  • `transient` : panne passagère (Discord en erreur 5xx, coupure réseau), à retenter ;
 *  • `failed` : message refusé pour une autre raison, le retenter échouerait encore.
 */
export type DmResult = 'sent' | 'closed' | 'transient' | 'failed';

const CLOSED = new Set<unknown>([RESTJSONErrorCodes.CannotSendMessagesToThisUser, RESTJSONErrorCodes.UnknownUser]);

/** Envoie un MP et dit s'il a été remis, ou pourquoi il ne l'a pas été. */
export async function sendDM(client: Client, userId: string, payload: MessageCreateOptions): Promise<DmResult> {
    try {
        const user = await client.users.fetch(userId);
        await user.send(payload);
        return 'sent';
    } catch (e: any) {
        // Cas courant et normal : MP fermés dans les réglages de confidentialité.
        if (CLOSED.has(e?.code)) {
            log('MP', `${userId} n'accepte pas les MP du bot : message non remis.`);
            return 'closed';
        }
        logError('MP', `Envoi d'un MP à ${userId} impossible :`, e);
        // Discord répond 4xx (hors 429) à une requête qu'il refusera toujours. Le reste,
        // 5xx, 429 ou erreur sans statut (réseau, délai dépassé), est passager.
        const status = e?.status;
        return typeof status === 'number' && status >= 400 && status < 500 && status !== 429 ? 'failed' : 'transient';
    }
}
