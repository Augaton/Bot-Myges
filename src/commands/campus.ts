import * as fs from 'node:fs';
import { ChatInputCommandInteraction, EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { Command } from '../core/command';
import { hasAccount } from '../core/store';
import { CAMPUS_FILE } from '../config';
import { logError } from '../utils/logger';

// Les adresses sont publiques ; les codes d'accès, eux, ne doivent pas figurer
// dans le dépôt (il est public). Ils sont lus dans campus.json, hors dépôt :
// voir campus.example.json pour le format.
const CAMPUSES = [
    { key: 'nation', name: '🏢 Nation 1 & 2', address: '242 Rue du Faubourg Saint-Antoine, 75012 Paris' },
    { key: 'erard', name: '🏢 Erard', address: '21 Rue Erard, 75012 Paris' },
    { key: 'voltaire1', name: '🎨 Voltaire 1 (Studio Crea)', address: '1 Rue Bouvier, 75011 Paris' },
    { key: 'voltaire2', name: '📷 Voltaire 2 (Efet)', address: '1 Rue Bouvier, 75011 Paris' },
    { key: 'rauch', name: '🏛️ Rauch', address: '15 Rue Rames, 75012 Paris' },
];

/** Relu à chaque appel : modifier campus.json ne demande pas de redémarrage. */
function readCodes(): Record<string, string> {
    try {
        return JSON.parse(fs.readFileSync(CAMPUS_FILE, 'utf-8'));
    } catch (e: any) {
        if (e?.code !== 'ENOENT') logError('CAMPUS', `${CAMPUS_FILE} illisible :`, e);
        return {};
    }
}

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('campus')
        .setDescription("Adresses et codes d'accès des campus de l'ESGI"),

    execute: async (interaction: ChatInputCommandInteraction) => {
        // Codes réservés aux étudiants identifiés : un compte MyGes enregistré suffit.
        if (!hasAccount(interaction.user.id)) {
            return interaction.reply({ content: "❌ Connecte-toi d'abord avec `/login`.", flags: MessageFlags.Ephemeral });
        }

        const codes = readCodes();
        const embed = new EmbedBuilder()
            .setTitle("🏫 Campus & Codes d'accès")
            .setDescription("Retrouvez ci-dessous les adresses et les codes d'entrée des différents bâtiments du réseau.")
            .setColor(0x3498db)
            .setThumbnail(interaction.client.user?.displayAvatarURL() || null)
            .addFields(
                CAMPUSES.map((c) => ({
                    name: c.name,
                    value: `📍 *${c.address}*\n🔑 Code : ${codes[c.key] ? `**${codes[c.key]}**` : '*non renseigné*'}`,
                }))
            )
            .setFooter({ text: 'Gardez ces codes pour vous ! 🤫' })
            .setTimestamp();

        // Volontairement sans bouton « Partager » : des codes d'accès n'ont rien
        // à faire en clair dans un salon.
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
};

export default command;
