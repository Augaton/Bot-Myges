// Réponses communes aux commandes qui interrogent MyGes : obtention de la
// session et messages d'erreur adaptés à la cause réelle du problème.
import { ActionRowBuilder, ButtonBuilder } from 'discord.js';
import type { CommandInteraction } from '../core/command';
import { loginButton } from '../core/hub';
import { getSession, hasAccount, loginFailure } from '../core/store';
import { MyGesError } from '../myges/errors';
import type { GesAuthenticationToken } from '../myges/types/auth';

/** Pourquoi on ne peut pas agir au nom de cet utilisateur. */
export function noSessionMessage(userId: string): string {
    if (!hasAccount(userId)) return "❌ Connecte-toi d'abord avec `/login`.";
    if (loginFailure(userId) === 'bad-credentials') {
        return '🔒 MyGes refuse tes identifiants enregistrés (mot de passe changé ?). Refais `/login`.';
    }
    return '⚠️ Impossible de joindre MyGes pour le moment. Réessaie dans une minute.';
}

/** Le motif, et le bouton « Se connecter » quand il faut se (re)connecter. */
export function noSessionReply(userId: string) {
    const relogin = !hasAccount(userId) || loginFailure(userId) === 'bad-credentials';
    return {
        content: noSessionMessage(userId),
        components: relogin ? [new ActionRowBuilder<ButtonBuilder>().addComponents(loginButton())] : [],
    };
}

/**
 * Session MyGes de l'auteur de la commande (rétablie à la volée si besoin), ou
 * null après lui avoir expliqué pourquoi. L'interaction doit déjà être différée.
 */
export async function sessionFor(interaction: CommandInteraction): Promise<GesAuthenticationToken | null> {
    const session = await getSession(interaction.user.id);
    if (!session) await interaction.editReply(noSessionReply(interaction.user.id));
    return session;
}

/**
 * Message d'erreur selon la cause : panne MyGes (5xx), délai dépassé, session
 * refusée… `what` désigne la donnée demandée, ex. « les notes ».
 */
export function apiErrorMessage(e: unknown, what: string): string {
    if (e instanceof MyGesError) {
        if (e.status === 401 || e.status === 403) {
            return "🔒 Ta session MyGes a expiré et n'a pas pu être renouvelée. Refais `/login`.";
        }
        if (e.status >= 500) {
            return `⚠️ MyGes rencontre un problème (erreur ${e.status}) : impossible de récupérer ${what}. Réessaie dans quelques minutes.`;
        }
    }
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        return `⌛ MyGes met trop de temps à répondre (${what}). Réessaie dans un instant.`;
    }
    return `❌ Impossible de récupérer ${what}.`;
}
