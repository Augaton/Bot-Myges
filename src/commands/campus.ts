import * as fs from 'node:fs';
import { ChatInputCommandInteraction, EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { Command } from '../core/command';
import { getTimetable } from '../core/mygesData';
import { getSession, hasAccount } from '../core/store';
import { CAMPUS_FILE } from '../config';
import { addDays, startOfDay } from '../utils/datePicker';
import { log, logError } from '../utils/logger';
import { apiErrorMessage, noSessionMessage } from '../utils/replies';

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

// Présence vérifiée sur 9 semaines autour d'aujourd'hui : un alternant peut ne pas
// venir pendant plusieurs semaines, et c'est une durée que MyGes sert d'un seul coup.
const OUR_CAMPUSES = /nation|erard|voltaire|rauch/i;
const LOOK_BACK_DAYS = 21;
const LOOK_AHEAD_DAYS = 42;

/** Relu à chaque appel : modifier campus.json ne demande pas de redémarrage. */
function readCodes(): Record<string, string> {
    try {
        return JSON.parse(fs.readFileSync(CAMPUS_FILE, 'utf-8'));
    } catch (e: any) {
        if (e?.code !== 'ENOENT') logError('CAMPUS', `${CAMPUS_FILE} illisible :`, e);
        return {};
    }
}

/** Campus (au sens de MyGes) cités par ces cours : NATION1, VOLTAIRE2, REIMS… */
function campusesOf(courses: any[]): Set<string> {
    const rooms = courses.flatMap((c) => (Array.isArray(c?.rooms) ? c.rooms : []));
    return new Set(rooms.map((r: any) => String(r?.campus ?? '')).filter(Boolean));
}

/**
 * Motif du refus, ou null si ces codes peuvent être affichés. Ils ouvrent des
 * bâtiments : il faut que MyGes confirme, à l'instant, que l'étudiant y a cours.
 * Une lecture réelle écarte aussi une session ouverte avant son départ de l'école.
 * Sans réponse de MyGes, rien n'est confirmé, donc rien n'est affiché.
 */
async function accessRefusal(userId: string): Promise<string | null> {
    const token = await getSession(userId);
    if (!token) return noSessionMessage(userId);

    let courses: any[];
    try {
        const today = startOfDay(new Date());
        courses = await getTimetable(userId, token, addDays(today, -LOOK_BACK_DAYS), addDays(today, LOOK_AHEAD_DAYS));
    } catch (e) {
        logError('CAMPUS', 'Vérification de l\'accès impossible :', e);
        return apiErrorMessage(e, 'ton agenda pour vérifier ton accès');
    }

    const seen = campusesOf(courses);
    if ([...seen].some((campus) => OUR_CAMPUSES.test(campus))) return null;
    // Les noms de campus ne sont pas personnels, et disent s'il faut compléter OUR_CAMPUSES.
    log('CAMPUS', `Accès refusé à ${userId}, campus de son agenda : ${[...seen].join(', ') || 'aucun'}`);
    return '🔒 Ces codes sont réservés aux étudiants qui ont cours sur ces campus, et je n\'en trouve aucun dans ton agenda.';
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

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const refusal = await accessRefusal(interaction.user.id);
        if (refusal) return interaction.editReply(refusal);

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
        await interaction.editReply({ embeds: [embed] });
    },
};

export default command;
