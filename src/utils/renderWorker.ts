// Worker de rendu : exécute les dessins canvas dans un thread séparé.
// Voir renderPool.ts pour l'orchestration côté thread principal.
//
// Ce fichier n'est jamais importé directement : il est chargé par `new Worker()`.
import { parentPort } from 'node:worker_threads';
import { renderDayImage, renderWeekImage } from './agendaImage';
import { renderNotesOverview, renderSubjectCard } from './notesImage';

if (!parentPort) {
    throw new Error('renderWorker doit être démarré comme worker_thread, pas importé.');
}

const port = parentPort;

port.on('message', (msg: { job: string; args: any[] }) => {
    try {
        const a = msg.args;
        let buffer: Buffer;
        switch (msg.job) {
            case 'agendaWeek':
                buffer = renderWeekImage(a[0], a[1]);
                break;
            case 'agendaDay':
                buffer = renderDayImage(a[0], a[1]);
                break;
            case 'notesOverview':
                buffer = renderNotesOverview(a[0], a[1], a[2]);
                break;
            case 'notesCard':
                buffer = renderSubjectCard(a[0], a[1], a[2], a[3]);
                break;
            default:
                throw new Error(`Job de rendu inconnu : ${msg.job}`);
        }
        port.postMessage({ ok: true, buffer });
    } catch (e) {
        port.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
});
