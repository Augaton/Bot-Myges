import {
    ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction,
    EmbedBuilder, MessageFlags, SlashCommandBuilder, StringSelectMenuBuilder,
} from 'discord.js';
import { Command } from '../core/command';
import { getGrades } from '../core/mygesData';
import { log, logError } from '../utils/logger';
import { apiErrorMessage, sessionFor } from '../utils/replies';
import { shareRow, SHARE_ID } from '../utils/share';
import {
    generalAverage, shortAverage, Subject, subjectColor, subjectEmoji, toSubject,
} from '../utils/notesImage';
import { renderNotesOverviewAsync, renderSubjectCardAsync } from '../utils/renderPool';

// Discord limite un menu déroulant à 25 options.
const MENU_MAX = 25;

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('notes')
        .setDescription('Affiche les notes et moyennes par matière (vue graphique)'),

    execute: async (interaction: ChatInputCommandInteraction) => {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const token = await sessionFor(interaction);
        if (!token) return;

        let grades: any[];
        try {
            grades = await getGrades(interaction.user.id, token);
        } catch (e) {
            logError('NOTES', 'Récupération des notes impossible :', e);
            return interaction.editReply(apiErrorMessage(e, 'les notes'));
        }
        if (!grades || grades.length === 0) return interaction.editReply('Aucune note disponible.');

        // Tri naturel ("Trimestre 2" après "Trimestre 1") : l'ordre renvoyé par
        // l'API n'est pas garanti, on veut un affichage stable.
        const semesters = ([...new Set(grades.map((g: any) => g.trimester_name))].filter(Boolean) as string[])
            .sort((a, b) => a.localeCompare(b, 'fr', { numeric: true }));
        if (!semesters.length) return interaction.editReply('Aucun trimestre disponible.');

        // Moyennes par trimestre calculées UNE fois. Elles alimentent le menu
        // déroulant, reconstruit à chaque rafraîchissement de la vue : les
        // recalculer là re-parcourait toutes les notes de toutes les matières
        // à chaque clic.
        const averageBySemester = new Map<string, number | null>(
            semesters.map((s) => [s, generalAverage(grades.filter((g: any) => g.trimester_name === s).map(toSubject))])
        );

        // --- ÉTAT DE NAVIGATION ---
        let semester = semesters[semesters.length - 1]; // le plus récent par défaut
        let subjects: Subject[] = [];
        let view: 'overview' | 'detail' = 'overview';
        let index = 0;
        // Matière mise en évidence dans la vue d'ensemble (celle qu'on vient de
        // consulter en détail) : -1 tant qu'aucune n'a été ouverte.
        let highlight = -1;

        const loadSemester = (name: string) => {
            semester = name;
            subjects = grades
                .filter((g: any) => g.trimester_name === name)
                .map(toSubject)
                .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
            index = 0;
            highlight = -1;
            view = 'overview';
        };

        // --- COMPOSANTS ---
        const semesterRow = () => {
            const menu = new StringSelectMenuBuilder()
                .setCustomId('sem')
                .setPlaceholder('📅 Trimestre')
                .addOptions(
                    semesters.slice(0, MENU_MAX).map((s) => {
                        const avg = averageBySemester.get(s) ?? null;
                        return {
                            label: s.slice(0, 100),
                            value: s.slice(0, 100),
                            description: avg === null ? 'Pas encore de moyenne' : `Moyenne générale : ${avg.toFixed(2)}/20`,
                            emoji: '🎓',
                            default: s === semester,
                        };
                    })
                );
            return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
        };

        const subjectRow = () => {
            const menu = new StringSelectMenuBuilder()
                .setCustomId('subject')
                .setPlaceholder('📘 Voir le détail d’une matière')
                .addOptions(
                    subjects.slice(0, MENU_MAX).map((s, i) => ({
                        label: s.name.slice(0, 100),
                        value: String(i),
                        description: `${shortAverage(s)}${s.ects !== null ? ` · ${s.ects} ECTS` : ''}`.slice(0, 100),
                        emoji: subjectEmoji(s),
                        default: view === 'detail' && i === index,
                    }))
                );
            return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
        };

        const buttonRow = () => new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('prev').setLabel('⬅️').setStyle(ButtonStyle.Secondary)
                .setDisabled(view !== 'detail' || index === 0),
            new ButtonBuilder().setCustomId('overview').setLabel("📊 Vue d'ensemble").setStyle(ButtonStyle.Primary)
                .setDisabled(view === 'overview'),
            new ButtonBuilder().setCustomId('next').setLabel('➡️').setStyle(ButtonStyle.Secondary)
                .setDisabled(view !== 'detail' || index >= subjects.length - 1)
        );

        // --- RENDU ---
        const buildView = async () => {
            // Le rendu canvas part sur un thread dédié : l'event-loop reste
            // disponible pour accuser réception des autres interactions.
            const detail = view === 'detail' && subjects[index];
            const buffer = detail
                ? await renderSubjectCardAsync(subjects[index], semester, index, subjects.length)
                : await renderNotesOverviewAsync(subjects, semester, highlight);

            const gen = generalAverage(subjects);
            const embed = new EmbedBuilder()
                .setColor(detail ? subjectColor(subjects[index]) : gen !== null && gen >= 10 ? 0x23a55a : 0x5865f2)
                .setImage('attachment://notes.png');

            return {
                content: null,
                embeds: [embed],
                files: [new AttachmentBuilder(buffer, { name: 'notes.png' })],
                components: subjects.length
                    ? [semesterRow(), subjectRow(), buttonRow(), shareRow()]
                    : [semesterRow(), shareRow()],
            };
        };

        loadSemester(semester);
        const msg = await interaction.editReply(await buildView());
        log('NOTES', `/notes par ${interaction.user.tag} · ${subjects.length} matières (${semester})`);

        // Un seul collecteur pour tous les composants : pas d'écouteurs empilés
        // lorsqu'on change de trimestre.
        const col = msg.createMessageComponentCollector({ time: 300_000 });

        col.on('collect', async (i) => {
            try {
                if (i.user.id !== interaction.user.id) {
                    await i.reply({ content: 'Pas touche !', flags: MessageFlags.Ephemeral });
                    return;
                }
                col.resetTimer(); // tant que l'utilisateur navigue, la session reste ouverte
                if (i.customId === SHARE_ID) return; // traité par le routeur global
                await i.deferUpdate();

                if (i.isStringSelectMenu()) {
                    if (i.customId === 'sem') loadSemester(i.values[0]);
                    else if (i.customId === 'subject') {
                        // Borné : le menu peut dater d'un trimestre plus fourni.
                        index = Math.min(Math.max(0, Number(i.values[0]) || 0), subjects.length - 1);
                        view = 'detail';
                    }
                } else if (i.customId === 'overview') {
                    highlight = index; // on repère d'où l'on vient dans le graphique
                    view = 'overview';
                } else if (i.customId === 'prev') {
                    index = Math.max(0, index - 1);
                } else if (i.customId === 'next') {
                    index = Math.min(subjects.length - 1, index + 1);
                }

                await interaction.editReply(await buildView());
            } catch (e) {
                logError('NOTES', 'Mise à jour de la vue impossible :', e);
            }
        });

        col.on('end', async () => {
            // Retire la navigation devenue inerte, mais garde le partage : le
            // bouton est routé globalement, il fonctionne encore après coup.
            try {
                await interaction.editReply({ components: [shareRow()] });
            } catch {
                /* message ephemère déjà expiré : rien à faire */
            }
        });
    },
};

export default command;
