// Séparé de format.ts : celui-ci est chargé par les threads de rendu, qui n'ont
// pas à charger discord.js.
import { escapeMarkdown } from 'discord.js';

/**
 * Neutralise le Markdown d'un texte venu de MyGes avant de l'afficher dans un
 * embed : un « * » ne casse plus la mise en forme, et surtout un lien masqué
 * `[Dépose ton rendu ici](https://…)` ne peut pas se faire passer pour le bot.
 */
export const md = (text: string) => escapeMarkdown(text, { maskedLink: true, heading: true });
