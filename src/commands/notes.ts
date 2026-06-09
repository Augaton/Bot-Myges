import {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction, ComponentType,
    EmbedBuilder, MessageFlags, SlashCommandBuilder, StringSelectMenuBuilder,
} from 'discord.js';
import { Command } from '../core/command';
import { ProfileService } from '../myges/services/profile';
import { getCurrentYear } from '../config';
import { sessions } from '../core/store';

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('notes')
        .setDescription('Affiche les notes et moyennes par matière'),

    execute: async (interaction: ChatInputCommandInteraction) => {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const token = sessions.get(interaction.user.id);
        if (!token) return interaction.editReply("❌ Connecte-toi d'abord. (/login)");

        try {
            const grades: any[] = await ProfileService.getGrades(token, getCurrentYear());
            if (!grades || grades.length === 0) return interaction.editReply('Aucune note disponible.');

            const sems = [...new Set(grades.map((g: any) => g.trimester_name))].filter(Boolean);

            // Menu de sélection du semestre
            const selectMenu = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('sem_select')
                    .setPlaceholder('📅 Choisis ton trimestre')
                    .addOptions(sems.map((s: any) => ({ label: s, value: s, emoji: '🎓' })))
            );

            const initialMsg = await interaction.editReply({
                content: 'Veuillez sélectionner un trimestre :',
                components: [selectMenu],
            });

            const menuCollector = initialMsg.createMessageComponentCollector({
                componentType: ComponentType.StringSelect,
                time: 60000,
            });

            // Permet d'arrêter le collecteur de boutons précédent lorsqu'on
            // change de trimestre, pour éviter d'empiler des écouteurs actifs.
            let buttonCollector: any = null;

            menuCollector.on('collect', async (menuInter) => {
                if (menuInter.user.id !== interaction.user.id) return;

                const semesterName = menuInter.values[0];
                const selectedGrades = grades.filter((g: any) => g.trimester_name === semesterName);

                // Tri par nom de matière
                selectedGrades.sort((a, b) => (a.course || '').localeCompare(b.course || ''));

                let index = 0;

                // --- FONCTION GÉNÉRATION DE LA CARTE ---
                const generateGradeCard = (i: number) => {
                    const g = selectedGrades[i];

                    // Nettoyage du nom (ex: "T1 - anglais" -> "Anglais")
                    const courseName = (g.course || 'Matière inconnue').replace(/^T\d+\s-\s/i, '');
                    const prof = g.teacher_last_name ? `👨‍🏫 ${g.teacher_first_name || ''} ${g.teacher_last_name}` : '';

                    // Calcul de la couleur selon la moyenne
                    let color = 0x95a5a6; // Gris par défaut
                    let mention = '';
                    let avgDisplay = 'N/A';

                    // On utilise g.average s'il existe (note finale validée),
                    // sinon on regarde s'il y a une moyenne CC (ccaverage)
                    const finalNote = g.average;

                    if (finalNote !== null && finalNote !== undefined) {
                        const note = parseFloat(finalNote);
                        avgDisplay = `${note.toFixed(2)}/20`;
                        if (note >= 16) { color = 0xf1c40f; mention = '🏆 Excellent'; }
                        else if (note >= 14) { color = 0x2ecc71; mention = '✅ Bien'; }
                        else if (note >= 10) { color = 0x0099ff; mention = '👌 Validé'; }
                        else { color = 0xe74c3c; mention = '⚠️ Rattrapage'; }
                    } else if (g.ccaverage > 0) {
                        // Si pas de moyenne générale mais une moyenne CC
                        avgDisplay = `~${g.ccaverage}/20 (CC)`;
                        color = 0x3498db; // Bleu (En cours)
                    }

                    // --- LOGIQUE D'AFFICHAGE DES NOTES CC ---
                    let ccContent = '-';
                    if (g.grades && Array.isArray(g.grades) && g.grades.length > 0) {
                        const details = g.grades.map((val: number, idx: number) => `• Note ${idx + 1} : **${val}/20**`).join('\n');
                        ccContent = `${details}\n\n👉 **Moy. CC : ${g.ccaverage ?? '?'}/20**`;
                    } else if (g.ccaverage !== null && g.ccaverage !== 0) {
                        ccContent = `**${g.ccaverage}/20**`;
                    } else {
                        ccContent = 'Aucune note';
                    }

                    const absText = g.absences > 0 ? `🚫 **${g.absences}** abs.` : '✅ 0';

                    return new EmbedBuilder()
                        .setTitle(`📘 ${courseName}`)
                        .setDescription(`${prof}\n*${semesterName}*`)
                        .setColor(color)
                        .addFields(
                            { name: '📊 Moyenne Générale', value: `# ${avgDisplay}\n${mention}`, inline: false },
                            { name: '📝 Contrôle Continu', value: ccContent, inline: true },
                            { name: '🎓 Examen Final', value: g.exam ? `**${g.exam}/20**` : '-', inline: true },
                            { name: 'Assiduité', value: absText, inline: true }
                        )
                        .setFooter({ text: `Matière ${i + 1} / ${selectedGrades.length} • Crédits: ${g.ects || '?'}` });
                };

                const getNavButtons = (idx: number) => new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId('prev_g').setLabel('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(idx === 0),
                    new ButtonBuilder().setCustomId('next_g').setLabel('➡️').setStyle(ButtonStyle.Secondary).setDisabled(idx === selectedGrades.length - 1)
                );

                await menuInter.update({
                    content: null,
                    embeds: [generateGradeCard(index)],
                    components: [getNavButtons(index)],
                });

                // On stoppe l'éventuel collecteur de boutons d'un trimestre
                // précédemment sélectionné avant d'en créer un nouveau.
                buttonCollector?.stop();
                buttonCollector = initialMsg.createMessageComponentCollector({
                    componentType: ComponentType.Button,
                    time: 120000,
                });

                buttonCollector.on('collect', async (btnInter: any) => {
                    if (btnInter.user.id !== interaction.user.id) return btnInter.reply({ content: 'Non.', flags: MessageFlags.Ephemeral });
                    await btnInter.deferUpdate();

                    if (btnInter.customId === 'prev_g') index--;
                    else if (btnInter.customId === 'next_g') index++;

                    if (index < 0) index = 0;
                    if (index >= selectedGrades.length) index = selectedGrades.length - 1;

                    await interaction.editReply({
                        embeds: [generateGradeCard(index)],
                        components: [getNavButtons(index)],
                    });
                });
            });
        } catch (e) {
            console.error(e);
            interaction.editReply('❌ Erreur notes.');
        }
    },
};

export default command;
