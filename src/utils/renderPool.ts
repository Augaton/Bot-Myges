// Pool de threads pour les rendus canvas.
//
// Pourquoi : un rendu d'agenda hebdomadaire coûte ~120 ms de CPU **synchrone**.
// Sur le thread principal, ce temps est du blocage pur : pendant qu'une image se
// dessine, le bot ne peut ni accuser réception d'une interaction (Discord n'en
// laisse que 3 s, au-delà c'est l'erreur 10062 « Unknown interaction ») ni
// répondre à qui que ce soit d'autre. Une poignée d'utilisateurs cliquant sur
// les flèches en même temps suffisait à faire échouer des commandes.
//
// Le pool déporte ces rendus sur des threads dédiés : l'event-loop reste libre.
// Règle de conception : le pool ne doit JAMAIS faire échouer un rendu. Toute
// défaillance (worker qui ne démarre pas, qui plante ou qui se bloque) retombe
// sur le rendu synchrone d'origine — plus lent, mais correct.
import { Worker } from 'node:worker_threads';
import * as os from 'node:os';
import * as path from 'node:path';
import { log, logError } from './logger';
import { renderDayImage, renderWeekImage } from './agendaImage';
import { renderNotesOverview, renderSubjectCard, Subject } from './notesImage';

// `.js` après build, `.ts` en dev (Node exécute le TypeScript nativement) :
// on s'aligne sur l'extension de ce fichier-ci.
const WORKER_FILE = path.join(__dirname, `renderWorker${path.extname(__filename)}`);

// Deux threads au plus. Chaque worker garde ~100-150 Mo de caches Skia une fois
// chaud : à 4 workers, le rendu seul dépassait 380 Mo de RAM, de quoi faire
// tuer le bot (OOM) sur un petit serveur après quelques heures. Un rendu dure
// ~100 ms, deux threads suffisent largement à la charge d'une promo.
const POOL_SIZE = Math.max(1, Math.min(2, os.availableParallelism() - 1));

// Filet contre un worker bloqué : au-delà, on le tue et on rejoue le rendu.
const JOB_TIMEOUT_MS = 15_000;

// Un worker qui meurt sans avoir jamais rendu la moindre image signale un
// problème de fond (fichier introuvable, binaire canvas illisible…). Au-delà de
// ce nombre de démarrages ratés, on cesse de relancer : sans ce garde-fou, un
// worker qui échoue au démarrage déclencherait un re-spawn en boucle infinie.
const MAX_FAILED_STARTS = POOL_SIZE * 2;

interface Job {
    job: string;
    args: any[];
    inline: () => Buffer; // rendu synchrone équivalent, utilisé en repli
    resolve: (buffer: Buffer) => void;
    reject: (error: Error) => void;
}

interface Slot {
    worker: Worker;
    current: Job | null;
    timer: NodeJS.Timeout | null;
    didWork: boolean; // a déjà renvoyé au moins un résultat
}

let slots: Slot[] | null = null;
let poolDead = false; // bascule définitive en rendu synchrone
let failedStarts = 0;
const queue: Job[] = [];

// --- Repli synchrone ---

/**
 * Rend l'image sur le thread principal. On cède la main une fois d'abord, pour
 * laisser passer les interactions en attente avant de bloquer l'event-loop —
 * exactement ce que faisait le code d'origine.
 */
function runInline(job: Job) {
    setImmediate(() => {
        try {
            job.resolve(job.inline());
        } catch (e) {
            job.reject(e instanceof Error ? e : new Error(String(e)));
        }
    });
}

/** Le pool n'est plus exploitable : on bascule tout, y compris la file d'attente. */
function killPool(reason: string) {
    if (poolDead) return;
    poolDead = true;
    logError('RENDER', `Pool de rendu abandonné (${reason}) : bascule en rendu synchrone.`);

    const dying = slots;
    slots = null;
    if (dying) {
        for (const slot of dying) {
            // Les rendus déjà confiés à un worker doivent être repris tout de
            // suite : sans ça, ils attendraient l'expiration de leur minuteur.
            const job = release(slot);
            if (job) runInline(job);
            void slot.worker.terminate().catch(() => {
                /* déjà mort */
            });
        }
    }

    // Personne ne doit rester en attente d'un pool qui n'existe plus.
    while (queue.length) runInline(queue.shift()!);
}

// --- Cycle de vie des workers ---

/** Détache le job en cours d'un slot et annule son minuteur. */
function release(slot: Slot): Job | null {
    if (slot.timer) {
        clearTimeout(slot.timer);
        slot.timer = null;
    }
    const job = slot.current;
    slot.current = null;
    return job;
}

function spawn(): Slot | null {
    let worker: Worker;
    try {
        worker = new Worker(WORKER_FILE);
    } catch (e) {
        // Échec synchrone (rare) ; l'échec asynchrone passe par 'error' ci-dessous.
        logError('RENDER', 'Démarrage du worker de rendu impossible :', e);
        failedStarts++;
        return null;
    }

    const slot: Slot = { worker, current: null, timer: null, didWork: false };

    worker.on('message', (msg: { ok: boolean; buffer?: Uint8Array; error?: string }) => {
        slot.didWork = true;
        const job = release(slot);
        if (!job) return;
        if (msg.ok && msg.buffer) job.resolve(Buffer.from(msg.buffer));
        // Erreur de rendu (et non de worker) : rejouer inline ne servirait à
        // rien, le même dessin échouerait pareil.
        else job.reject(new Error(msg.error || 'rendu en échec'));
        pump();
    });

    worker.on('error', (e) => recycle(slot, e instanceof Error ? e : new Error(String(e))));
    worker.on('exit', (code) => {
        if (code !== 0) recycle(slot, new Error(`worker de rendu terminé (code ${code})`));
    });

    // Ne retient pas le processus : l'arrêt du bot reste immédiat. Un job en vol
    // est de toute façon protégé par son minuteur, qui garde l'event-loop actif.
    worker.unref();
    return slot;
}

/** Un worker a échoué ou s'est bloqué : on sauve son job et on le remplace. */
function recycle(slot: Slot, error: Error) {
    const job = release(slot);

    // Un worker mort sans avoir jamais travaillé = démarrage raté.
    if (!slot.didWork) failedStarts++;

    void slot.worker.terminate().catch(() => {
        /* déjà mort */
    });

    // Le job n'est pas perdu : on le rejoue sur le thread principal. L'utilisateur
    // voit son image, simplement rendue de la façon lente.
    if (job) {
        logError('RENDER', `Rendu « ${job.job} » repris en synchrone : ${error.message}`);
        runInline(job);
    }

    if (!slots) return; // pool déjà démantelé
    const i = slots.indexOf(slot);
    if (i === -1) return; // slot déjà remplacé

    if (failedStarts >= MAX_FAILED_STARTS) {
        killPool(`${failedStarts} démarrages de worker en échec`);
        return;
    }

    const fresh = spawn();
    if (fresh) {
        slots[i] = fresh;
    } else {
        slots.splice(i, 1);
        if (!slots.length) {
            killPool('plus aucun worker disponible');
            return;
        }
    }
    pump();
}

function ensurePool(): boolean {
    if (poolDead) return false;
    if (slots) return slots.length > 0;

    const created: Slot[] = [];
    for (let i = 0; i < POOL_SIZE; i++) {
        const slot = spawn();
        if (slot) created.push(slot);
    }
    if (!created.length) {
        killPool('aucun worker n\'a pu démarrer');
        return false;
    }
    slots = created;
    log('RENDER', `Pool de rendu démarré : ${created.length} thread(s).`);
    return true;
}

/** Distribue les jobs en attente aux workers libres. */
function pump() {
    if (!slots) return;
    for (const slot of slots) {
        if (slot.current || !queue.length) continue;
        const job = queue.shift()!;
        slot.current = job;
        slot.timer = setTimeout(
            () => recycle(slot, new Error(`rendu interrompu après ${JOB_TIMEOUT_MS} ms`)),
            JOB_TIMEOUT_MS
        );
        slot.worker.postMessage({ job: job.job, args: job.args });
    }
}

function run(job: string, args: any[], inline: () => Buffer): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
        const item: Job = { job, args, inline, resolve, reject };
        if (!ensurePool()) {
            runInline(item);
            return;
        }
        queue.push(item);
        pump();
    });
}

// --- API publique (miroir asynchrone des rendus synchrones) ---

export const renderAgendaWeek = (courses: any[], weekStart: Date): Promise<Buffer> =>
    run('agendaWeek', [courses, weekStart], () => renderWeekImage(courses, weekStart));

export const renderAgendaDay = (courses: any[], date: Date): Promise<Buffer> =>
    run('agendaDay', [courses, date], () => renderDayImage(courses, date));

export const renderNotesOverviewAsync = (
    subjects: Subject[], semester: string, highlight: number
): Promise<Buffer> =>
    run('notesOverview', [subjects, semester, highlight], () =>
        renderNotesOverview(subjects, semester, highlight));

export const renderSubjectCardAsync = (
    subject: Subject, semester: string, index: number, total: number
): Promise<Buffer> =>
    run('notesCard', [subject, semester, index, total], () =>
        renderSubjectCard(subject, semester, index, total));

/** Arrêt propre : appelé au shutdown du bot. */
export async function shutdownRenderPool() {
    const current = slots;
    slots = null;
    if (!current) return;
    await Promise.allSettled(current.map((s) => s.worker.terminate()));
}
