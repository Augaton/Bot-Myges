// Garde-fous communs aux panneaux interactifs (flèches, menus déroulants).
import { MessageComponentInteraction, MessageFlags } from 'discord.js';
import { RateLimiter } from './rateLimit';

// Un clic peut coûter une lecture MyGes et un rendu. Largement au-dessus d'un
// usage normal : une personne qui parcourt l'agenda clique rarement si vite.
const clickLimiter = new RateLimiter(20, 30_000);

// Discord invalide le jeton d'une interaction au bout de 15 min : au-delà, le
// panneau ne pourrait plus être mis à jour, quoi que fasse l'utilisateur.
const MAX_LIFETIME_MS = 14 * 60_000;

/** Vrai si ce clic dépasse la limite ; l'utilisateur en est alors prévenu. */
export async function tooManyClicks(i: MessageComponentInteraction): Promise<boolean> {
    if (clickLimiter.hit(i.user.id)) return false;
    await i.reply({ content: '⏳ Doucement ! Réessaie dans quelques secondes.', flags: MessageFlags.Ephemeral }).catch(() => {});
    return true;
}

/**
 * Durée de vie maximale d'un collecteur. Sans elle, `resetTimer` le prolonge à
 * chaque clic, et ses données restent en mémoire aussi longtemps qu'on clique.
 */
export function limitLifetime(collector: { stop(reason?: string): void; once(event: 'end', listener: () => void): unknown }) {
    const timer = setTimeout(() => collector.stop('lifetime'), MAX_LIFETIME_MS);
    timer.unref?.();
    collector.once('end', () => clearTimeout(timer));
}
