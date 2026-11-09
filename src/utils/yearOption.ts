// Option « annee » des commandes /notes et /absences : seulement les années de l'étudiant.
import { AutocompleteInteraction, ChatInputCommandInteraction, SlashCommandStringOption } from 'discord.js';
import { getCurrentYearFor, getYears } from '../core/mygesData';
import { getSession } from '../core/store';
import type { GesAuthenticationToken } from '../myges/types/auth';
import { yearChoices, yearLabel } from './schoolYear';

// Discord n'attend la réponse d'une autocomplétion que 3 s.
const AUTOCOMPLETE_BUDGET_MS = 2_500;

export const yearOption = (option: SlashCommandStringOption) => option
    .setName('annee')
    .setDescription('Année scolaire (par défaut : l\'année en cours)')
    .setAutocomplete(true);

async function choicesFor(userId: string): Promise<{ name: string; value: string }[] | null> {
    const token = await getSession(userId);
    if (!token) return null;
    const [years, current] = await Promise.all([getYears(userId, token), getCurrentYearFor(userId, token)]);
    return years.map((year) => ({ name: year === current ? `${yearLabel(year)} (en cours)` : yearLabel(year), value: year }));
}

export async function yearAutocomplete(interaction: AutocompleteInteraction) {
    const typed = interaction.options.getFocused().trim().toLowerCase();
    const late = new Promise<null>((resolve) => setTimeout(() => resolve(null), AUTOCOMPLETE_BUDGET_MS).unref());
    // Sans session ou trop lent (reconnexion à MyGes) : les dernières années, plutôt que rien.
    const choices = (await Promise.race([choicesFor(interaction.user.id).catch(() => null), late])) ?? yearChoices();
    await interaction.respond(choices.filter((choice) => choice.name.toLowerCase().includes(typed)).slice(0, 25));
}

/**
 * Année demandée : sans option, l'année en cours selon MyGes ; sinon l'une des années
 * de l'étudiant, ou null si ce n'en est pas une.
 */
export async function resolveYear(interaction: ChatInputCommandInteraction, token: GesAuthenticationToken): Promise<{ year: string; current: string } | null> {
    const userId = interaction.user.id;
    const [years, current] = await Promise.all([getYears(userId, token), getCurrentYearFor(userId, token)]);
    const asked = interaction.options.getString('annee');
    if (!asked) return { year: current, current };
    return years.includes(asked) ? { year: asked, current } : null;
}
