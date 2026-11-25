import { AutocompleteInteraction, ButtonInteraction, ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';

/**
 * Ce qui lance une commande : la commande slash, ou un bouton du tableau de bord
 * (voir core/hub), qui n'a pas d'options. Les deux savent répondre, différer et
 * ouvrir un formulaire de la même façon.
 */
export type CommandInteraction = ChatInputCommandInteraction | ButtonInteraction;

export interface Command {
    data: Pick<SlashCommandBuilder, 'name' | 'toJSON'>;
    execute: (interaction: CommandInteraction) => Promise<unknown>;
    /** Propositions pendant la saisie d'une option en autocomplétion. */
    autocomplete?: (interaction: AutocompleteInteraction) => Promise<unknown>;
}
