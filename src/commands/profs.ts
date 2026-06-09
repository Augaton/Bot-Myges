import {
    ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction,
    ComponentType, EmbedBuilder, MessageFlags, SlashCommandBuilder,
} from 'discord.js';
import { Command } from '../core/command';
import { SchoolService } from '../myges/services/school';
import { getCurrentYear } from '../config';
import { sessions } from '../core/store';

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('profs')
        .setDescription('Liste des professeurs de ta classe'),

    execute: async (interaction: ChatInputCommandInteraction) => {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const token = sessions.get(interaction.user.id);
        if (!token) return interaction.editReply("❌ Connecte-toi d'abord. (/login)");

        try {
            const teachers: any[] = await SchoolService.getTeachers(token, getCurrentYear());
            if (!teachers || teachers.length === 0) return interaction.editReply('Aucun professeur trouvé pour cette année.');

            // Tri alphabétique par nom de famille
            teachers.sort((a, b) => a.lastname.localeCompare(b.lastname));

            let index = 0;

            const showTeacher = async (i: number) => {
                const t = teachers[i];

                let photoUrl = null;
                if (t.links && Array.isArray(t.links)) {
                    const photoObj = t.links.find((l: any) => l.rel === 'photo');
                    if (photoObj) photoUrl = photoObj.href;
                }

                let files: AttachmentBuilder[] = [];

                const embed = new EmbedBuilder()
                    .setTitle('👨‍🏫 Mes Professeurs')
                    .setDescription(`Professeur ${i + 1}/${teachers.length}`)
                    .setColor(0xf1c40f)
                    .addFields(
                        { name: 'Nom', value: `**${t.firstname} ${t.lastname}**`, inline: true },
                        { name: 'Email', value: t.email ? `📧 ${t.email}` : 'Non renseigné', inline: false }
                    )
                    .setFooter({ text: `ID: ${t.uid || 'N/A'}` });

                // Téléchargement de l'image (public d'abord, puis avec le token)
                if (photoUrl) {
                    try {
                        let response = await fetch(photoUrl);
                        if (!response.ok) {
                            response = await fetch(photoUrl, {
                                headers: { Authorization: `${token.token_type} ${token.access_token}` },
                            });
                        }
                        if (response.ok) {
                            const buffer = Buffer.from(await response.arrayBuffer());
                            files = [new AttachmentBuilder(buffer, { name: 'teacher.jpg' })];
                            embed.setImage('attachment://teacher.jpg');
                        }
                    } catch (err) {
                        console.error('Erreur image prof:', err);
                    }
                }

                const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId('prev_t').setLabel('⬅️').setStyle(ButtonStyle.Primary).setDisabled(i === 0),
                    new ButtonBuilder().setCustomId('next_t').setLabel('➡️').setStyle(ButtonStyle.Primary).setDisabled(i === teachers.length - 1)
                );

                return { embeds: [embed], components: [buttons], files };
            };

            const payload = await showTeacher(index);
            const msg = await interaction.editReply(payload);

            const collector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 300000 });

            collector.on('collect', async (i) => {
                if (i.user.id !== interaction.user.id) return i.reply({ content: 'Pas touche !', flags: MessageFlags.Ephemeral });
                await i.deferUpdate();

                if (i.customId === 'prev_t') index--;
                else if (i.customId === 'next_t') index++;

                if (index < 0) index = 0;
                if (index >= teachers.length) index = teachers.length - 1;

                await interaction.editReply(await showTeacher(index));
            });
        } catch (e) {
            console.error(e);
            interaction.editReply('❌ Erreur lors de la récupération des professeurs.');
        }
    },
};

export default command;
