import {
    ActionRowBuilder, AttachmentBuilder, ChatInputCommandInteraction, ComponentType, EmbedBuilder, MessageFlags,
    SlashCommandBuilder, StringSelectMenuBuilder, StringSelectMenuInteraction,
} from 'discord.js';
import { Command } from '../core/command';
import { getCurrentYear } from '../config';
import { FileTooLargeError } from '../myges/errors';
import { DocumentService } from '../myges/services/document';
import { ProfileService } from '../myges/services/profile';
import { limitLifetime, tooManyClicks } from '../utils/collector';
import { courseName, snippet } from '../utils/format';
import { log, logError } from '../utils/logger';
import { md } from '../utils/markdown';
import { apiErrorMessage, sessionFor } from '../utils/replies';

// Discord limite un menu déroulant à 25 options.
const MENU_MAX = 25;
const ANNUAL = 'annual';
// Le fichier transite en entier par la RAM du bot : plafond fixe, même sur un
// serveur boosté où Discord accepterait bien plus.
const MAX_FILE_BYTES = 25 * 1024 * 1024;
// Limite d'envoi standard, si Discord n'annonce pas celle du salon. Sans elle,
// Math.min donnerait NaN et plus aucun plafond ne s'appliquerait.
const DEFAULT_ATTACHMENT_LIMIT = 10 * 1024 * 1024;

// Un téléchargement occupe jusqu'à MAX_FILE_BYTES de mémoire : au plus un par
// personne, toutes commandes confondues, et quelques-uns en tout.
const MAX_PARALLEL_DOWNLOADS = 3;
const downloading = new Set<string>();

/** Réserve une place de téléchargement ; renvoie le motif du refus s'il n'y en a pas. */
export function acquireDownload(userId: string): string | null {
    if (downloading.has(userId)) return '⏳ Un téléchargement est déjà en cours pour toi.';
    if (downloading.size >= MAX_PARALLEL_DOWNLOADS) return '⏳ Trop de téléchargements en cours. Réessaie dans un instant.';
    downloading.add(userId);
    return null;
}

export function releaseDownload(userId: string) {
    downloading.delete(userId);
}

export interface DocumentSource {
    id: string;
    name: string;
    hint: string;
}

export interface MygesDocument {
    id: string;
    title: string;
    fileName: string;
    date: number | null;
}

/** Matières proposées : celles qui annoncent des documents d'abord, sans doublon. */
export function courseSources(raw: any): DocumentSource[] {
    if (!Array.isArray(raw)) return [];
    const byId = new Map<string, { source: DocumentSource; hasDocuments: boolean }>();
    for (const c of raw) {
        const id = c?.rc_id ?? c?.rcId ?? c?.id;
        if (id == null || byId.has(String(id))) continue;
        byId.set(String(id), {
            source: { id: String(id), name: courseName(c), hint: String(c?.trimester_name || c?.teacher || '') },
            hasDocuments: c?.has_documents === true,
        });
    }
    return [...byId.values()]
        .sort((a, b) => Number(b.hasDocuments) - Number(a.hasDocuments) || a.source.name.localeCompare(b.source.name, 'fr', { numeric: true }))
        .map((entry) => entry.source);
}

/** Ajoute l'extension annoncée par MyGes, sauf si le nom la porte déjà ou que c'est un type MIME. */
function withExtension(name: string, extension: unknown): string {
    const ext = String(extension ?? '').replace(/^\./, '');
    if (!/^[a-z0-9]{1,8}$/i.test(ext) || name.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) return name;
    return `${name}.${ext}`;
}

/**
 * Documents d'une réponse MyGes, du plus récent au plus ancien : un tableau
 * pour les supports de cours, parfois { annualDocuments, documents } pour les
 * documents administratifs. Une entrée sans identifiant ne peut pas être téléchargée.
 */
export function toDocuments(payload: any): MygesDocument[] {
    const raw: any[] = Array.isArray(payload)
        ? payload
        : [payload?.annualDocuments, payload?.documents].filter(Array.isArray).flat();
    const byId = new Map<string, MygesDocument>();
    for (const d of raw) {
        const id = d?.oc_id ?? d?.id ?? d?.document_id;
        if (id == null) continue;
        const title = snippet(String(d?.label || d?.title || d?.name || d?.filename || ''), 100) || 'Document';
        byId.set(String(id), {
            id: String(id),
            title,
            fileName: withExtension(String(d?.filename || title), d?.extension),
            date: new Date(d?.update_date ?? d?.date ?? d?.last_update).getTime() || null,
        });
    }
    return [...byId.values()].sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
}

/** Nom de fichier sûr : il vient de MyGes (ou de ses en-têtes), pas de nous. */
export function safeFileName(name: string): string {
    const clean = name.normalize('NFC').replace(/[\\/:*?"<>|\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().replace(/^[.\s]+/, '');
    // Tronqué par le début : l'extension importe plus que le début du titre.
    return clean.slice(-100) || 'document';
}

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('documents')
        .setDescription('Télécharger tes supports de cours et documents administratifs'),

    execute: async (interaction: ChatInputCommandInteraction) => {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const token = await sessionFor(interaction);
        if (!token) return;

        const year = getCurrentYear();
        let courses: DocumentSource[];
        try {
            courses = courseSources(await ProfileService.getCourses(token, year));
        } catch (e) {
            logError('DOCUMENTS', 'Récupération des matières impossible :', e);
            return interaction.editReply(apiErrorMessage(e, 'la liste de tes matières'));
        }
        const sources: DocumentSource[] = [
            { id: ANNUAL, name: 'Documents administratifs', hint: 'Certificats, bulletins…' },
            ...courses,
        ].slice(0, MENU_MAX);

        // --- ÉTAT DE NAVIGATION ---
        let selected: DocumentSource | null = null;
        let files: MygesDocument[] = [];
        let notice: string | null = null;

        const describe = () => {
            if (notice) return notice;
            if (!selected) return 'Choisis une matière, ou tes documents administratifs. Le fichier t\'est envoyé ici, visible par toi seul.';
            if (!files.length) return `Aucun document pour **${md(selected.name)}**.`;
            const count = files.length > MENU_MAX ? `les ${MENU_MAX} plus récents sur ${files.length}` : `${files.length} document${files.length > 1 ? 's' : ''}`;
            return `**${md(selected.name)}** · ${count}. Choisis un fichier pour le recevoir.`;
        };

        // Volontairement sans bouton « Partager » : certificats et bulletins
        // contiennent des données personnelles.
        const view = () => {
            const rows = [
                new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId('doc_source')
                        .setPlaceholder('📂 Choisis une matière')
                        .addOptions(sources.map((s) => ({
                            label: s.name.slice(0, 100),
                            value: s.id,
                            description: s.hint.slice(0, 100) || undefined,
                            emoji: s.id === ANNUAL ? '🎓' : '📘',
                            default: s.id === selected?.id,
                        })))
                ),
            ];
            if (files.length) {
                rows.push(
                    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId('doc_file')
                            .setPlaceholder('📎 Choisis un fichier')
                            .addOptions(files.slice(0, MENU_MAX).map((d) => ({
                                label: d.title.slice(0, 100),
                                value: d.id,
                                description: d.date ? new Date(d.date).toLocaleDateString('fr-FR') : undefined,
                            })))
                    )
                );
            }
            return {
                embeds: [new EmbedBuilder().setTitle('📚 Mes documents').setDescription(describe()).setColor(0x5865f2)],
                components: rows,
            };
        };

        const openSource = async (id: string) => {
            selected = sources.find((s) => s.id === id) ?? null;
            files = [];
            notice = null;
            if (!selected) return;
            try {
                const payload = id === ANNUAL
                    ? await DocumentService.getAnnualDocuments(token, year)
                    : await DocumentService.getCourseFiles(token, id);
                files = toDocuments(payload);
                // Format inattendu : les noms de champs (jamais les valeurs) suffisent à l'adapter.
                if (!files.length && payload && !(Array.isArray(payload) && !payload.length)) {
                    const sample = Array.isArray(payload) ? payload[0] : payload;
                    log('DOCUMENTS', `Réponse non reconnue (${id === ANNUAL ? 'administratifs' : 'matière'}), champs : ${Object.keys(Object(sample)).join(', ')}`);
                }
            } catch (e) {
                logError('DOCUMENTS', 'Récupération des documents impossible :', e);
                notice = apiErrorMessage(e, 'ces documents');
            }
        };

        const sendFile = async (i: StringSelectMenuInteraction, id: string) => {
            const doc = files.find((d) => d.id === id);
            if (!doc || !selected) return;
            const refused = acquireDownload(interaction.user.id);
            if (refused) {
                await i.followUp({ content: refused, flags: MessageFlags.Ephemeral });
                return;
            }
            const limit = Math.min(i.attachmentSizeLimit || DEFAULT_ATTACHMENT_LIMIT, MAX_FILE_BYTES);
            try {
                const { data, fileName } = selected.id === ANNUAL
                    ? await DocumentService.downloadAnnualDocument(token, doc.id, limit)
                    : await DocumentService.downloadCourseFile(token, selected.id, doc.id, limit);
                await i.followUp({
                    content: `📎 **${md(doc.title)}**`,
                    files: [new AttachmentBuilder(data, { name: safeFileName(fileName || doc.fileName) })],
                    flags: MessageFlags.Ephemeral,
                });
                log('DOCUMENTS', `${interaction.user.id} : fichier envoyé (${Math.ceil(data.length / 1024)} Ko)`);
            } catch (e) {
                const tooLarge = e instanceof FileTooLargeError;
                if (!tooLarge) logError('DOCUMENTS', 'Téléchargement impossible :', e);
                await i.followUp({
                    content: tooLarge
                        ? `📦 Ce fichier dépasse ${Math.round(limit / 1048576)} Mo, la limite d'envoi ici. Récupère-le sur MyGes.`
                        : apiErrorMessage(e, 'ce fichier'),
                    flags: MessageFlags.Ephemeral,
                });
            } finally {
                releaseDownload(interaction.user.id);
            }
        };

        const msg = await interaction.editReply(view());
        const collector = msg.createMessageComponentCollector({
            componentType: ComponentType.StringSelect,
            time: 300_000,
            filter: (i) => i.user.id === interaction.user.id,
        });

        limitLifetime(collector);

        collector.on('collect', async (i) => {
            try {
                if (await tooManyClicks(i)) return;
                collector.resetTimer(); // tant que l'utilisateur navigue, la session reste ouverte
                await i.deferUpdate();
                if (i.customId === 'doc_source') await openSource(i.values[0]);
                else if (i.customId === 'doc_file') await sendFile(i, i.values[0]);
                // Aussi après un envoi : remet le menu à zéro, pour pouvoir redemander le même fichier.
                await interaction.editReply(view());
            } catch (e) {
                logError('DOCUMENTS', 'Mise à jour de la vue impossible :', e);
            }
        });

        collector.on('end', async () => {
            await interaction.editReply({ components: [] }).catch(() => {});
        });
    },
};

export default command;
