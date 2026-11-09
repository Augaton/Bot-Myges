import { AutocompleteInteraction, ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';

export interface Command {
    data: Pick<SlashCommandBuilder, 'name' | 'toJSON'>;
    execute: (interaction: ChatInputCommandInteraction) => Promise<unknown>;
    /** Propositions pendant la saisie d'une option en autocomplétion. */
    autocomplete?: (interaction: AutocompleteInteraction) => Promise<unknown>;
}
