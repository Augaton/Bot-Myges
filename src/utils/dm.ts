// Envoi de messages privés (alertes de notes, rappels de rendus).
import { Client, MessageCreateOptions, RESTJSONErrorCodes } from 'discord.js';
import { log, logError } from './logger';

/** Envoie un MP ; renvoie faux si l'utilisateur ne peut pas en recevoir. */
export async function sendDM(client: Client, userId: string, payload: MessageCreateOptions): Promise<boolean> {
    try {
        const user = await client.users.fetch(userId);
        await user.send(payload);
        return true;
    } catch (e: any) {
        // Cas courant et normal : MP fermés dans les réglages de confidentialité.
        if (e?.code === RESTJSONErrorCodes.CannotSendMessagesToThisUser) {
            log('MP', `${userId} n'accepte pas les MP du bot : message non remis.`);
        } else {
            logError('MP', `Envoi d'un MP à ${userId} impossible :`, e);
        }
        return false;
    }
}
