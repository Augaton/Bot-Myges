import { ChatInputCommandInteraction, EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { Command } from '../core/command';
import { panelPublicUrl } from '../config';
import { createFeed, feedSecret, refreshFeed, removeFeed } from '../tasks/agendaFeeds';
import { logError } from '../utils/logger';
import { apiErrorMessage, sessionFor } from '../utils/replies';

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('abonnement')
        .setDescription('Abonne ton calendrier à ton agenda MyGES, mis à jour tout seul')
        .addStringOption((option) => option
            .setName('action')
            .setDescription('Que faire ? (par défaut : afficher ton lien)')
            .addChoices(
                { name: 'Afficher mon lien', value: 'lien' },
                { name: 'Nouveau lien (l\'ancien cesse de marcher)', value: 'nouveau' },
                { name: 'Supprimer l\'abonnement', value: 'supprimer' },
            )),

    execute: async (interaction: ChatInputCommandInteraction) => {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const userId = interaction.user.id;
        const action = interaction.options.getString('action') ?? 'lien';
        if (action === 'supprimer') {
            return interaction.editReply(removeFeed(userId) ? '🗑️ Abonnement supprimé : son lien ne fonctionne plus.' : 'Tu n\'as pas d\'abonnement.');
        }
        const base = panelPublicUrl().replace(/\/+$/, '');
        if (!base) return interaction.editReply('Le panel n\'a pas d\'adresse publique : l\'administrateur doit renseigner PANEL_PUBLIC_URL.');
        const token = await sessionFor(interaction);
        if (!token) return;

        const secret = (action !== 'nouveau' && feedSecret(userId)) || createFeed(userId);
        try {
            await refreshFeed(userId, secret, token);
        } catch (e) {
            logError('AGENDA', 'Préparation de l\'abonnement impossible :', e);
            return interaction.editReply(apiErrorMessage(e, 'ton agenda'));
        }
        const link = `${base}/agenda/${secret}.ics`;
        await interaction.editReply({
            embeds: [new EmbedBuilder()
                .setTitle('📅 Abonnement à ton agenda')
                .setColor(0x5865f2)
                .setDescription(
                    `${link}\n\nColle ce lien dans ton calendrier :\n` +
                    '• **Google Agenda** (sur ordinateur) : Autres agendas → **+** → À partir de l\'URL.\n' +
                    '• **iPhone** : Réglages → Calendrier → Comptes → Ajouter un compte → Autre → Calendrier avec abonnement.\n\n' +
                    'Les 12 prochaines semaines, préparées toutes les 30 minutes. Google Agenda les relit à son rythme, souvent quelques heures.',
                )
                .addFields({ name: '🔒 Garde-le pour toi', value: 'Ce lien donne accès à ton agenda. `/abonnement` avec « Nouveau lien » le remplace, « Supprimer » le coupe.' })],
        });
    },
};

export default command;
