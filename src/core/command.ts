import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';

export interface Command {
    data: Pick<SlashCommandBuilder, 'name' | 'toJSON'>;
    execute: (interaction: ChatInputCommandInteraction) => Promise<unknown>;
}
