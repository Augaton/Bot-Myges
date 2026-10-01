// Partage public d'une vue éphémère.
// Un message éphémère n'est visible que par la personne qui a lancé la commande
// et ne peut pas être « rendu public » : on en recopie donc le contenu (embeds
// et images) dans un nouveau message visible par tout le salon.
//
// Le bouton est routé globalement (voir index.ts), il fonctionne donc aussi sur
// les commandes qui n'ont pas de collecteur. Les commandes qui en ont un
// doivent ignorer SHARE_ID pour ne pas acquitter l'interaction deux fois.
import {
    ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonInteraction, ButtonStyle, EmbedBuilder,
    MessageFlags,
} from 'discord.js';
import { log, logError } from './logger';

export const SHARE_ID = 'share_public';

export const shareButton = () =>
    new ButtonBuilder().setCustomId(SHARE_ID).setLabel('📢 Partager dans le salon').setStyle(ButtonStyle.Secondary);

/** Rangée dédiée : le bouton reste à l'écart des flèches de navigation. */
export const shareRow = () => new ActionRowBuilder<ButtonBuilder>().addComponents(shareButton());

// Nom de fichier d'une URL CDN Discord, sans les paramètres de signature.
const fileNameOf = (url: string) => url.split('?')[0].split('/').pop() || '';

// Seules les pièces jointes hébergées par Discord sont re-téléchargées, avec un
// délai et une taille bornés : le bot ne doit jamais aller chercher n'importe quoi.
const CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const isDiscordCdn = (url: string) => {
    try {
        const u = new URL(url);
        return u.protocol === 'https:' && CDN_HOSTS.has(u.hostname);
    } catch {
        return false;
    }
};

export async function handleShare(i: ButtonInteraction) {
    try {
        await i.deferUpdate(); // la vue éphémère reste telle quelle
    } catch (e) {
        logError('SHARE', 'Accusé de réception impossible :', e);
        return;
    }

    try {
        // Les pièces jointes d'un éphémère ne sont lisibles que par son
        // destinataire : on les ré-uploade dans le message public.
        const files: AttachmentBuilder[] = [];
        const reuploaded = new Set<string>();
        for (const att of i.message.attachments.values()) {
            if (!isDiscordCdn(att.url) || att.size > MAX_ATTACHMENT_BYTES) {
                logError('SHARE', `Pièce jointe « ${att.name} » ignorée (hôte ou taille non autorisés).`);
                continue;
            }
            try {
                const res = await fetch(att.url, { signal: AbortSignal.timeout(10_000) });
                if (!res.ok) {
                    await res.body?.cancel().catch(() => {});
                    continue;
                }
                files.push(new AttachmentBuilder(Buffer.from(await res.arrayBuffer()), { name: att.name }));
                reuploaded.add(att.name);
            } catch (e) {
                logError('SHARE', `Pièce jointe « ${att.name} » non récupérée :`, e);
            }
        }

        // Les embeds relus depuis l'API pointent vers l'URL CDN de l'éphémère :
        // on les redirige vers le fichier ré-uploadé quand on l'a bien récupéré,
        // sinon on garde l'URL d'origine (elle reste affichable un temps).
        const embeds = i.message.embeds.map((e) => {
            const b = EmbedBuilder.from(e);
            const img = e.image?.url;
            const thumb = e.thumbnail?.url;
            if (img && reuploaded.has(fileNameOf(img))) b.setImage(`attachment://${fileNameOf(img)}`);
            if (thumb && reuploaded.has(fileNameOf(thumb))) b.setThumbnail(`attachment://${fileNameOf(thumb)}`);
            return b;
        });

        if (!embeds.length && !files.length && !i.message.content) {
            await i.followUp({ content: '❌ Rien à partager ici.', flags: MessageFlags.Ephemeral });
            return;
        }

        await i.followUp({
            content: `📢 Partagé par <@${i.user.id}>${i.message.content ? `\n${i.message.content}` : ''}`,
            embeds,
            files,
            allowedMentions: { parse: [] }, // l'attribution ne doit notifier personne
        });
        log('SHARE', `Vue partagée par ${i.user.tag} dans ${i.channelId}`);
    } catch (e) {
        logError('SHARE', 'Partage impossible :', e);
        try {
            await i.followUp({
                content: "❌ Partage impossible ici (le bot n'a peut-être pas le droit d'écrire dans ce salon).",
                flags: MessageFlags.Ephemeral,
            });
        } catch {
            /* l'interaction a expiré : rien de plus à faire */
        }
    }
}
