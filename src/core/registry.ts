import { Collection } from 'discord.js';
import { Command } from './command';

import login from '../commands/login';
import logout from '../commands/logout';
import prochain from '../commands/prochain';
import agenda from '../commands/agenda';
import notes from '../commands/notes';
import absences from '../commands/absences';
import projets from '../commands/projets';
import profil from '../commands/profil';
import news from '../commands/news';
import profs from '../commands/profs';
import trombi from '../commands/trombi';
import campus from '../commands/campus';
import changelog from '../commands/changelog';
import help from '../commands/help';
import ping from '../commands/ping';
import config from '../commands/config';

// Ordre conservé pour l'affichage dans Discord.
const all: Command[] = [
    login, logout, prochain, agenda, notes, absences, projets, profil,
    news, profs, trombi, campus, changelog, help, ping, config,
];

// Map name -> Command pour le routage des interactions.
export const commands = new Collection<string, Command>();
for (const cmd of all) commands.set(cmd.data.name, cmd);

// Corps JSON à envoyer à l'API Discord pour l'enregistrement.
export const commandsJSON = all.map((c) => c.data.toJSON());
