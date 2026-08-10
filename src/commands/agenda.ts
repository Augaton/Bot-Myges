import {
    ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction,
    EmbedBuilder, MessageFlags, SlashCommandBuilder, StringSelectMenuBuilder,
} from 'discord.js';
import { Command } from '../core/command';
import { TimetableService } from '../myges/services/timetable';
import { sessions } from '../core/store';
import { renderAgendaDay, renderAgendaWeek } from '../utils/renderPool';
import { logError } from '../utils/logger';
import { addDays, dayOptions, fromKey, getMonday, sameDay, startOfDay, weekOptions } from '../utils/datePicker';
import { TtlCache } from '../utils/ttlCache';
import { shareRow, SHARE_ID } from '../utils/share';

interface AgendaView {
    embeds: EmbedBuilder[];
    files: AttachmentBuilder[];
}

// Amplitude du décalage de la fenêtre de semaines proposées (≈ 3 mois).
const WINDOW_SHIFT_WEEKS = 13;

// Naviguer d'une semaine à l'autre puis revenir relançait un appel MyGes à
// chaque clic. Un cache court suffit à supprimer ces allers-retours tout en
// gardant un emploi du temps à jour. La clé inclut l'ID Discord : aucune donnée
// n'est partagée entre utilisateurs.
const TIMETABLE_TTL_MS = 60_000;
const timetableCache = new TtlCache<any[]>(TIMETABLE_TTL_MS, 200);

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('agenda')
        .setDescription('Voir les cours du jour ou de la semaine avec navigation'),

    execute: async (interaction: ChatInputCommandInteraction) => {
        // Discord n'accorde que 3 s pour accuser réception. Si l'hôte est lent
        // (event-loop bloqué, horloge décalée), deferReply peut échouer avec
        // 10062 « Unknown interaction » : on l'ignore proprement au lieu de crasher.
        try {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        } catch (e: any) {
            console.warn(`[Agenda] deferReply impossible (interaction expirée, code ${e?.code}).`);
            return;
        }

        const errorView = (msg: string): AgendaView => ({
            embeds: [new EmbedBuilder().setTitle('Erreur').setDescription(msg).setColor(0xff0000)],
            files: [],
        });

        // Génère la vue graphique (image PNG) pour un mode et une date de référence.
        const generateAgenda = async (mode: 'day' | 'week', refDate: Date): Promise<AgendaView> => {
            const currentToken = sessions.get(interaction.user.id);
            if (!currentToken) return errorView('Session expirée. Fais /login');

            let start: Date;
            let end: Date;
            if (mode === 'day') {
                start = startOfDay(refDate);
                end = new Date(start);
                end.setHours(23, 59, 59);
            } else {
                start = getMonday(refDate);
                end = addDays(start, 6);
                end.setHours(23, 59, 59);
            }

            try {
                const cacheKey = `${interaction.user.id}|${start.getTime()}|${end.getTime()}`;
                let cours = timetableCache.get(cacheKey);
                if (!cours) {
                    cours = (await TimetableService.getTimetable(currentToken, start, end)) || [];
                    timetableCache.set(cacheKey, cours);
                }

                // Le rendu canvas part sur un thread dédié : l'event-loop reste
                // disponible pour accuser réception des autres interactions.
                const buffer = mode === 'day'
                    ? await renderAgendaDay(cours, refDate)
                    : await renderAgendaWeek(cours, start);
                const file = new AttachmentBuilder(buffer, { name: 'agenda.png' });
                const embed = new EmbedBuilder()
                    .setColor(mode === 'day' ? 0x3498db : 0x5865f2)
                    .setImage('attachment://agenda.png');
                return { embeds: [embed], files: [file] };
            } catch (e) {
                logError('AGENDA', "Impossible de générer l'agenda :", e);
                return errorView("Impossible de récupérer l'agenda.");
            }
        };

        // --- ÉTAT DE NAVIGATION ---
        let currentMode: 'day' | 'week' = 'week';
        let currentDate = new Date();
        // Sélecteur de date : semaine servant de centre à la liste proposée, et
        // semaine dont on détaille les jours (mode jour).
        let pickerAnchor = getMonday(currentDate);
        let pickerWeek = getMonday(currentDate);

        // --- BARRE DE NAVIGATION ---
        const navRow = () => {
            const today = new Date();
            const onToday = currentMode === 'day'
                ? sameDay(today, currentDate)
                : sameDay(getMonday(today), getMonday(currentDate));
            return new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId('prev').setLabel('⬅️').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('today').setLabel("Aujourd'hui").setStyle(ButtonStyle.Primary).setDisabled(onToday),
                new ButtonBuilder().setCustomId('next').setLabel('➡️').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('switch')
                    .setLabel(currentMode === 'day' ? '📅 Voir Semaine' : '📆 Voir Jour').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('jump').setLabel('🗓️ Aller à...').setStyle(ButtonStyle.Secondary)
            );
        };

        // --- SÉLECTEUR DE DATE ---
        // Mode semaine : une seule liste de semaines, choisie = appliquée.
        // Mode jour    : la semaine choisie alimente la liste des jours.
        const pickerRows = () => {
            const today = new Date();
            // En mode jour, la semaine cochée est celle qu'on est en train de
            // détailler ; en mode semaine, c'est directement la vue affichée.
            const selectedWeek = currentMode === 'day' ? pickerWeek : currentDate;

            const weekMenu = new StringSelectMenuBuilder()
                .setCustomId('pick_week')
                .setPlaceholder(currentMode === 'day' ? '🗓️ 1. Choisis une semaine' : '🗓️ Choisis une semaine')
                .addOptions(weekOptions(pickerAnchor, selectedWeek, today));

            const rows: any[] = [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(weekMenu)];

            if (currentMode === 'day') {
                rows.push(
                    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId('pick_day')
                            .setPlaceholder('📆 2. Choisis un jour')
                            .addOptions(dayOptions(pickerWeek, currentDate, today))
                    )
                );
            }

            rows.push(
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId('pick_back').setLabel('⏪ 3 mois').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId('pick_today').setLabel("📍 Aujourd'hui").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId('pick_fwd').setLabel('3 mois ⏩').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId('pick_cancel').setLabel('↩️ Retour').setStyle(ButtonStyle.Danger)
                )
            );
            return rows;
        };

        const refresh = async () => {
            await interaction.editReply({
                ...(await generateAgenda(currentMode, currentDate)),
                components: [navRow(), shareRow()],
            });
        };

        const msg = await interaction.editReply({
            ...(await generateAgenda(currentMode, currentDate)),
            components: [navRow(), shareRow()],
        });

        // Un seul collecteur pour boutons et menus déroulants.
        const col = msg.createMessageComponentCollector({ time: 300_000 });

        col.on('collect', async (i) => {
            if (i.user.id !== interaction.user.id) {
                return i.reply({ content: 'Pas touche !', flags: MessageFlags.Ephemeral });
            }
            col.resetTimer(); // tant que l'utilisateur navigue, la session reste ouverte
            if (i.customId === SHARE_ID) return; // traité par le routeur global
            await i.deferUpdate();

            try {
                // --- Sélecteur de date ---
                if (i.isStringSelectMenu()) {
                    const picked = fromKey(i.values[0]);
                    if (i.customId === 'pick_week' && currentMode === 'day') {
                        // On reste dans le sélecteur : la semaine choisie alimente les jours.
                        pickerWeek = picked;
                        pickerAnchor = picked;
                        await interaction.editReply({ components: pickerRows() });
                        return;
                    }
                    // Semaine (mode semaine) ou jour choisi : on applique et on
                    // referme le sélecteur.
                    currentDate = picked;
                    await refresh();
                    return;
                }

                switch (i.customId) {
                    case 'jump': // ouvre le sélecteur (l'image reste affichée)
                        pickerAnchor = getMonday(currentDate);
                        pickerWeek = getMonday(currentDate);
                        return void (await interaction.editReply({ components: pickerRows() }));
                    case 'pick_cancel':
                        return void (await interaction.editReply({ components: [navRow(), shareRow()] }));
                    case 'pick_today':
                        currentDate = new Date();
                        return void (await refresh());
                    case 'pick_back':
                    case 'pick_fwd': {
                        // Décale la fenêtre de semaines proposées sans changer la vue.
                        const dir = i.customId === 'pick_back' ? -1 : 1;
                        pickerAnchor = addDays(pickerAnchor, dir * WINDOW_SHIFT_WEEKS * 7);
                        return void (await interaction.editReply({ components: pickerRows() }));
                    }
                }

                // --- Navigation classique ---
                if (i.customId === 'prev') {
                    currentDate = addDays(currentDate, currentMode === 'day' ? -1 : -7);
                } else if (i.customId === 'next') {
                    currentDate = addDays(currentDate, currentMode === 'day' ? 1 : 7);
                } else if (i.customId === 'today') {
                    currentDate = new Date();
                } else if (i.customId === 'switch') {
                    currentMode = currentMode === 'day' ? 'week' : 'day';
                }
                await refresh();
            } catch (e) {
                logError('AGENDA', "Mise à jour de l'agenda impossible :", e);
            }
        });

        col.on('end', async () => {
            // Retire la navigation devenue inerte, mais garde le partage : le
            // bouton est routé globalement, il fonctionne encore après coup.
            try {
                await interaction.editReply({ components: [shareRow()] });
            } catch {
                /* message éphémère déjà expiré : rien à faire */
            }
        });
    },
};

export default command;
