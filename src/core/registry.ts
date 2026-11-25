import { Collection } from 'discord.js';
import { Command } from './command';

import login from '../commands/login';
import logout from '../commands/logout';
import agenda from '../commands/agenda';
import notes from '../commands/notes';
import panel from '../commands/panel';
import campus from '../commands/campus';
import help from '../commands/help';
import config from '../commands/config';
import serveurs from '../commands/serveurs';
import alertes from '../commands/alertes';

// Ordre conservé pour l'affichage dans Discord. Le reste (absences, projets,
// documents, profil, annuaire, actualités) se consulte dans le panel.
const all: Command[] = [login, logout, panel, agenda, notes, alertes, campus, help, config, serveurs];

// Map name -> Command pour le routage des interactions.
export const commands = new Collection<string, Command>();
for (const cmd of all) commands.set(cmd.data.name, cmd);

// Corps JSON à envoyer à l'API Discord pour l'enregistrement.
export const commandsJSON = all.map((c) => c.data.toJSON());
