import {
    ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction,
    ComponentType, EmbedBuilder, MessageFlags, SlashCommandBuilder,
} from 'discord.js';
import { Command } from '../core/command';
import { SchoolService } from '../myges/services/school';
import { getCurrentYear } from '../config';
import { fetchPhotoBuffer } from '../utils/photo';
import { byLastName, fullName } from '../utils/format';
import { logError } from '../utils/logger';
import { apiErrorMessage, sessionFor } from '../utils/replies';
import { shareRow, SHARE_ID } from '../utils/share';

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('trombi')
        .setDescription('Affiche le trombinoscope de ta classe'),

    execute: async (interaction: ChatInputCommandInteraction) => {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const token = await sessionFor(interaction);
        if (!token) return;

        try {
            // 1. Récupérer les classes
            const classes: any[] = await SchoolService.getMyClasses(token, getCurrentYear());
            if (!classes || classes.length === 0) return interaction.editReply('❌ Aucune classe trouvée.');

            const maClasse = classes[0];
            const classId = maClasse.id || maClasse.class_id || maClasse.puid;

            // 2. Récupérer les élèves
            const students: any[] = await SchoolService.getClassmates(token, classId);
            if (!students || students.length === 0) return interaction.editReply('❌ Aucun élève trouvé.');

            // Tri alphabétique (tolérant aux noms manquants)
            students.sort(byLastName);

            let index = 0;
            // Cache des photos pour cette navigation : un même élève consulté
            // plusieurs fois n'est téléchargé qu'une seule fois.
            const photoCache = new Map<string, Buffer | null>();

            const showStudent = async (i: number) => {
                const s = students[i];

                let photoUrl = null;
                if (s.links && Array.isArray(s.links)) {
                    const photoObj = s.links.find((l: any) => l.rel === 'photo');
                    if (photoObj) photoUrl = photoObj.href;
                }

                let files: AttachmentBuilder[] = [];

                const embed = new EmbedBuilder()
                    .setTitle(`📸 Trombinoscope - ${maClasse.name || 'Classe'}`)
                    .setDescription(`Étudiant ${i + 1}/${students.length}`)
                    .setColor(0x0099ff)
                    .addFields(
                        { name: 'Nom', value: `**${fullName(s)}**`, inline: true },
                        { name: 'Email', value: s.email || 'Non renseigné', inline: true }
                    )
                    .setFooter({ text: `ID: ${s.uid || 'N/A'}` });

                if (photoUrl) {
                    const buffer = await fetchPhotoBuffer(photoUrl, token, photoCache);
                    if (buffer) {
                        files = [new AttachmentBuilder(buffer, { name: 'profile.jpg' })];
                        embed.setImage('attachment://profile.jpg');
                    }
                }

                const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId('prev_s').setLabel('⬅️').setStyle(ButtonStyle.Primary).setDisabled(i === 0),
                    new ButtonBuilder().setCustomId('next_s').setLabel('➡️').setStyle(ButtonStyle.Primary).setDisabled(i === students.length - 1)
                );

                return { embeds: [embed], components: [buttons, shareRow()], files };
            };

            const payload = await showStudent(index);
            const msg = await interaction.editReply(payload);

            const collector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 300000 });

            collector.on('collect', async (i) => {
                try {
                    if (i.user.id !== interaction.user.id) {
                        await i.reply({ content: 'Pas touche !', flags: MessageFlags.Ephemeral });
                        return;
                    }
                    if (i.customId === SHARE_ID) return; // traité par le routeur global
                    collector.resetTimer(); // tant que l'utilisateur navigue, la session reste ouverte
                    await i.deferUpdate();

                    if (i.customId === 'prev_s') index--;
                    else if (i.customId === 'next_s') index++;

                    if (index < 0) index = 0;
                    if (index >= students.length) index = students.length - 1;

                    await interaction.editReply(await showStudent(index));
                } catch (e) {
                    logError('TROMBI', 'Mise à jour de la fiche impossible :', e);
                }
            });

            collector.on('end', async () => {
                // Navigation devenue inerte : on la retire, le partage reste possible.
                await interaction.editReply({ components: [shareRow()] }).catch(() => {});
            });
        } catch (e) {
            logError('TROMBI', 'Récupération du trombinoscope impossible :', e);
            await interaction.editReply(apiErrorMessage(e, 'le trombinoscope'));
        }
    },
};

export default command;
