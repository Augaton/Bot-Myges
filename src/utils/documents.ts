// Documents MyGes : lecture des réponses et garde-fous, sans dépendance à Discord.
import { courseName, snippet } from './format';

// Le fichier transite en entier par la RAM : plafond fixe, même sur un serveur
// Discord boosté qui accepterait bien plus.
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

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
    category: string;
}

/** Matières proposées : celles qui annoncent des documents d'abord, sans doublon. */
export function courseSources(raw: any): DocumentSource[] {
    if (!Array.isArray(raw)) return [];
    const byId = new Map<string, { source: DocumentSource; hasDocuments: boolean }>();
    for (const c of raw) {
        const id = c?.rc_id ?? c?.rcId ?? c?.id;
        // MyGes dit quelles matières n'ont aucun document : inutile de les proposer.
        if (id == null || byId.has(String(id)) || c?.has_documents === false) continue;
        byId.set(String(id), {
            source: { id: String(id), name: courseName(c), hint: String(c?.trimester || c?.trimester_name || c?.teacher || '') },
            hasDocuments: c?.has_documents === true,
        });
    }
    return [...byId.values()]
        .sort((a, b) => Number(b.hasDocuments) - Number(a.hasDocuments) || a.source.name.localeCompare(b.source.name, 'fr', { numeric: true }))
        .map((entry) => entry.source);
}

/** « INFORMATIONS GENERALES » → « Informations generales ». */
const sentenceCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();

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
            category: sentenceCase(String(d?.category ?? '')),
        });
    }
    return [...byId.values()].sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
}

/** Nom de fichier sûr : il vient de MyGes (ou de ses en-têtes), pas de nous. */
export function safeFileName(name: string): string {
    const clean = name.normalize('NFC').replace(/[\\/:*?"<>|\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().replace(/^[.\s]+/, '');
    // Tronqué par le début : l'extension importe plus que le début du titre. La coupe
    // peut tomber au milieu d'un emoji, ce que encodeURIComponent refuserait.
    return clean.slice(-100).toWellFormed() || 'document';
}
