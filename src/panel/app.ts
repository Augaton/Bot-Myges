// Serveur du panel étudiant. Volontairement sans framework ni dépendance : quelques
// routes fixes, des en-têtes stricts, et aucune donnée MyGes stockée sur disque.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import {
    forgetAssignments, getAbsences, getAnnualDocuments, getAssignments, getClasses, getClassmatePhotos, getClassmates, getCourseFiles, getCourses, getEvents, getGrades, getNews, getProfile, getStudentPhoto, getSyllabus, getTeacherPhotos, getTeachers, getTimetable, getYears,
} from '../core/mygesData';
import { BadCredentialsError, FileTooLargeError, MyGesError } from '../myges/errors';
import { GesAPI } from '../myges/ges-api';
import { accountKey, VALID_USERNAME } from '../myges/identifier';
import { DocumentService } from '../myges/services/document';
import { ProfileService } from '../myges/services/profile';
import { ProjectService } from '../myges/services/project';
import type { DownloadedFile } from '../myges/services/base';
import { addDays, getMonday, startOfDay } from '../utils/datePicker';
import {
    acquireDownload, courseSources, MAX_FILE_BYTES, releaseDownload, safeFileName, toDocuments,
} from '../utils/documents';
import { fullName } from '../utils/format';
import { buildIcs } from '../utils/ics';
import { log, logError } from '../utils/logger';
import { fetchPhotoBuffer, imageType } from '../utils/photo';
import { RateLimiter } from '../utils/rateLimit';
import { getCurrentYear } from '../utils/schoolYear';
import { Session, Sessions } from './sessions';
import { absencesView, allEventsView, coursesView, directoryView, eventsView, monthDays, newsView, notesView, profileView, projectDetail, projectsView, syllabusView, teamMemberIds } from './views';
import type { GesAuthenticationToken } from '../myges/types/auth';

const COOKIE = '__Host-panel';
const MAX_BODY_BYTES = 4_096;
const ANNUAL = 'annual';
const WINDOW_MS = 15 * 60_000;
const CERT_RELOAD_MS = 6 * 3_600_000;
// Durée d'agenda que MyGes sert d'une seule requête, vérifiée sur un vrai compte.
const ICS_WEEKS = 12;
// Durée maximale d'un téléchargement, envoi au client compris.
const DOWNLOAD_DEADLINE_MS = 5 * 60_000;

const HEADERS = {
    'Content-Security-Policy':
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; manifest-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'Strict-Transport-Security': 'max-age=31536000',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

class HttpError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

const UNAVAILABLE = 'MyGES ne répond pas pour le moment. Réessaie dans quelques minutes.';

/** Vrai pour une panne, où aucun mot de passe n'a été testé. */
const isOutage = (e: unknown) => !(e instanceof MyGesError) || e.status >= 500 || e.status === 429;

function loadStaticFiles() {
    const dir = path.resolve(__dirname, '..', '..', 'assets', 'panel');
    const file = (name: string, type: string) => {
        const body = fs.readFileSync(path.join(dir, name));
        return {
            body,
            type,
            // Faible : le même fichier existe compressé ou non.
            etag: `W/"${crypto.createHash('sha256').update(body).digest('base64url').slice(0, 22)}"`,
            // Fichiers publics et fixes, sans donnée personnelle : aucun risque à les compresser.
            // Les réponses de l'API, elles, ne le sont pas. Les PNG le sont déjà.
            gzipped: type.startsWith('image/') ? null : zlib.gzipSync(body),
        };
    };
    // Liste fermée : aucun chemin demandé ne touche au disque.
    return new Map([
        ['/', file('index.html', 'text/html; charset=utf-8')],
        ['/app.js', file('app.js', 'text/javascript; charset=utf-8')],
        ['/style.css', file('style.css', 'text/css; charset=utf-8')],
        ['/manifest.webmanifest', file('manifest.webmanifest', 'application/manifest+json; charset=utf-8')],
        ['/icon-192.png', file('icon-192.png', 'image/png')],
        ['/icon-512.png', file('icon-512.png', 'image/png')],
        ['/apple-touch-icon.png', file('apple-touch-icon.png', 'image/png')],
    ]);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, extra: http.OutgoingHttpHeaders = {}) {
    res.writeHead(status, { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<any> {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Requête invalide.');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Requête trop volumineuse.');
        chunks.push(chunk);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    } catch {
        throw new HttpError(400, 'Requête invalide.');
    }
}

/** Une écriture ne vient que de la page du panel, jamais d'un autre site. */
function assertSameOrigin(req: http.IncomingMessage) {
    try {
        if (new URL(req.headers.origin ?? '').host === req.headers.host) return;
    } catch {
        /* Origin absent ou illisible : refusé ci-dessous */
    }
    throw new HttpError(403, 'Origine refusée.');
}

/**
 * Réseau d'une adresse : /24 en IPv4, /64 en IPv6, l'unité qu'un visiteur contrôle
 * réellement. Compter par adresse IPv6 ne limiterait personne.
 */
export function networkOf(address: string): string {
    const v4 = address.replace(/^::ffff:/i, '');
    if (net.isIPv4(v4)) return v4.split('.').slice(0, 3).join('.');
    if (!net.isIPv6(address)) return address;
    const [head, tail = ''] = address.toLowerCase().split('::');
    const start = head ? head.split(':') : [];
    const end = tail ? tail.split(':') : [];
    const zeros = Array.from({ length: Math.max(0, 8 - start.length - end.length) }, () => '0');
    return [...start, ...zeros, ...end].slice(0, 4).map((group) => group.replace(/^0+(?=.)/, '')).join(':');
}

/** Boucle locale ou réseau privé : d'où viendrait un proxy de confiance. */
export function isPrivateAddress(address: string): boolean {
    const ip = address.replace(/^::ffff:/i, '');
    return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) || ip === '::1' || /^f[cd]/i.test(ip);
}

/**
 * Derrière un proxy, seul lui peut parler au panel : il vient d'une adresse privée et
 * pose X-Forwarded-For. Le reste est un accès direct au port, en HTTP. Il ne doit
 * jamais obtenir le formulaire de connexion : le mot de passe y circulerait en clair,
 * même si le port a été ouvert par erreur.
 */
export function isDirectAccess(peer: string, forwarded: unknown): boolean {
    return !isPrivateAddress(peer) || !forwarded;
}

/** Une place dans un compteur : réservée avant d'interroger MyGes, rendue si l'essai ne compte pas. */
type Slot = [RateLimiter, string];

function reserve(slots: Slot[]): boolean {
    const taken: Slot[] = [];
    for (const slot of slots) {
        if (!slot[0].hit(slot[1])) {
            release(taken);
            return false;
        }
        taken.push(slot);
    }
    return true;
}

function release(slots: Slot[]) {
    for (const [limiter, key] of slots) limiter.forgive(key);
}

const readCookie = (req: http.IncomingMessage) => req.headers.cookie?.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`))?.[1];

export interface TlsFiles {
    cert: string;
    key: string;
}

const readTls = ({ cert, key }: TlsFiles) => ({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) });

/** Relit le certificat sur disque, sans couper les connexions en cours. */
export function reloadTls(server: https.Server, tls: TlsFiles) {
    try {
        server.setSecureContext(readTls(tls));
    } catch (e) {
        logError('PANEL', 'Rechargement du certificat impossible, l\'ancien reste en place :', e);
    }
}

export function createPanel({ trustProxy, tls, sessionsFile }: { trustProxy: boolean; tls?: TlsFiles; sessionsFile?: string }): http.Server | https.Server {
    const statics = loadStaticFiles();
    const sessions = new Sessions(sessionsFile);

    // Essais échoués. Un essai réussi ne compte pas : toute une classe peut se connecter
    // depuis le même Wi-Fi. Chaque limite vise un risque précis :
    const failedByVisitor = new RateLimiter(5, WINDOW_MS); // un visiteur insiste sur un compte
    const failedByNetwork = new RateLimiter(20, WINDOW_MS); // un réseau essaie un mot de passe sur tout le monde
    const failedByAccount = new RateLimiter(20, WINDOW_MS); // un compte visé depuis beaucoup de réseaux
    // Fusible : protège l'adresse du serveur vis-à-vis de Kordis. Haut, sinon quelques
    // échecs volontaires suffiraient à bloquer toutes les connexions.
    const failedTotal = new RateLimiter(300, WINDOW_MS);
    // Connexions en boucle sur son propre compte, qui sollicitent MyGes tout autant.
    const logins = new RateLimiter(10, WINDOW_MS);
    const requests = new RateLimiter(120, 60_000);
    // Une liste d'équipes affiche beaucoup de petites photos d'un coup : compteur à part.
    const photoRequests = new RateLimiter(300, 60_000);
    // Chaque changement d'équipe est une vraie action sur MyGes, et il est journalisé.
    const teamChanges = new RateLimiter(10, WINDOW_MS);

    const clientAddress = (req: http.IncomingMessage) => {
        const peer = req.socket.remoteAddress ?? '';
        // L'en-tête n'est cru que venant du proxy : sinon, qui atteindrait le port en
        // direct choisirait l'adresse qu'il présente, et échapperait aux limites.
        const forwarded = trustProxy && isPrivateAddress(peer) ? String(req.headers['x-forwarded-for'] ?? '').split(',').at(-1)?.trim() : '';
        return forwarded || peer || 'inconnue';
    };

    const requireSession = (req: http.IncomingMessage, limiter = requests): Session => {
        const session = sessions.get(readCookie(req));
        if (!session) throw new HttpError(401, 'Session expirée.');
        if (!limiter.hit(session.account)) throw new HttpError(429, 'Trop de requêtes. Réessaie dans un instant.');
        return session;
    };

    /** Exécute une lecture MyGes ; un token refusé ferme la session. */
    const read = async <T>(session: Session, load: (token: GesAuthenticationToken) => Promise<T>): Promise<T> => {
        try {
            return await load(session.token);
        } catch (e) {
            if (e instanceof MyGesError && e.status === 401) {
                sessions.drop(session);
                throw new HttpError(401, 'Session expirée.');
            }
            if (e instanceof HttpError || e instanceof FileTooLargeError) throw e;
            logError('PANEL', 'Lecture MyGes impossible :', e);
            throw new HttpError(502, UNAVAILABLE);
        }
    };

    async function login(req: http.IncomingMessage, res: http.ServerResponse) {
        assertSameOrigin(req);
        const body = await readJson(req);
        const username = typeof body?.username === 'string' ? body.username.trim() : '';
        const password = typeof body?.password === 'string' ? body.password : '';
        if (!VALID_USERNAME.test(username) || username.length > 100 || !password || password.length > 200) {
            throw new HttpError(400, 'Identifiant ou mot de passe invalide.');
        }

        const account = accountKey(username);
        const network = networkOf(clientAddress(req));
        const failureSlots: Slot[] = [
            [failedTotal, 'all'], [failedByNetwork, network], [failedByAccount, account], [failedByVisitor, `${account}|${network}`],
        ];
        const loginSlot: Slot[] = [[logins, account]];
        // Réservé avant l'appel : une rafale simultanée ne doit pas passer entre la
        // lecture du compteur et l'échec.
        if (!reserve([...failureSlots, ...loginSlot])) throw new HttpError(429, 'Trop de tentatives. Réessaie dans quelques minutes.');

        let token: GesAuthenticationToken;
        try {
            token = await GesAPI.login(username, password);
        } catch (e) {
            release(loginSlot);
            const refused = e instanceof BadCredentialsError;
            if (!refused && isOutage(e)) release(failureSlots); // aucun mot de passe n'a été testé
            if (refused) {
                log('PANEL', 'Connexion refusée.');
                throw new HttpError(401, 'Identifiant ou mot de passe incorrect.');
            }
            logError('PANEL', 'Connexion à MyGes impossible :', e);
            throw new HttpError(503, UNAVAILABLE);
        }
        release(failureSlots);

        // Le mot de passe est bon : reste à vérifier qu'il s'agit bien d'un étudiant.
        let role: unknown;
        let uid: number | null;
        try {
            const me = await ProfileService.getAccount(token);
            role = me?.normalized_role;
            uid = Number.isFinite(me?.uid) ? me.uid : null;
        } catch (e) {
            logError('PANEL', 'Lecture du rôle impossible :', e);
            throw new HttpError(503, UNAVAILABLE);
        }
        if (role !== 'student') {
            log('PANEL', 'Connexion refusée : ce compte n\'est pas un compte étudiant.');
            throw new HttpError(403, 'Ce panel est réservé aux étudiants.');
        }

        const profile = await ProfileService.getProfile(token).catch(() => null);
        const name = profile ? fullName({ firstname: profile?.firstname, lastname: profile?.name }) : username;
        const { cookie, session } = sessions.open(token, name, account, uid, body?.remember === true);
        log('PANEL', 'Connexion réussie.');
        // Sans Max-Age, le cookie disparaît à la fermeture du navigateur.
        const maxAge = session.remember ? `; Max-Age=${Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000))}` : '';
        sendJson(res, 200, { name: session.name }, {
            'Set-Cookie': `${COOKIE}=${cookie}; Path=/; HttpOnly; Secure; SameSite=Strict${maxAge}`,
        });
    }

    function logout(req: http.IncomingMessage, res: http.ServerResponse) {
        assertSameOrigin(req);
        sessions.close(readCookie(req));
        sendJson(res, 200, {}, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
    }

    async function home(session: Session) {
        const today = startOfDay(new Date());
        const [courses, grades, absences, projects, news, events] = await Promise.allSettled([
            // Six semaines : en alternance, le prochain cours peut être loin.
            read(session, (t) => getTimetable(session.key, t, today, addDays(today, 42))),
            read(session, (t) => getGrades(session.key, t)),
            read(session, (t) => getAbsences(session.key, t)),
            read(session, (t) => getAssignments(session.key, t)),
            read(session, (t) => getNews(session.key, t)),
            read(session, (t) => getEvents(session.key, t)),
        ]);
        // Un seul bloc en panne n'empêche pas d'afficher les autres. Un token refusé, si.
        for (const r of [courses, grades, absences, projects, news, events]) {
            if (r.status === 'rejected' && r.reason instanceof HttpError && r.reason.status === 401) throw r.reason;
        }
        const value = <T, R>(r: PromiseSettledResult<T>, view: (v: T) => R) => (r.status === 'fulfilled' ? view(r.value) : null);
        return {
            courses: value(courses, coursesView),
            semester: value(grades, (g) => notesView(g).at(-1) ?? null),
            absences: value(absences, (a) => { const { total, unjustified } = absencesView(a); return { total, unjustified }; }),
            deadlines: value(projects, (p) => projectsView(p, session.uid).filter((item) => item.date !== null)),
            news: value(news, (n) => newsView(n).slice(0, 3)),
            events: value(events, (e) => eventsView(e).slice(0, 3)),
        };
    }

    /** Un mois d'agenda : combien de cours chaque jour. La semaine en donne le détail. */
    async function agendaMonth(session: Session, month: string) {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, 'Mois invalide.');
        const [year, index] = month.split('-').map(Number);
        const first = new Date(year, index - 1, 1);
        const end = new Date(year, index, 0, 23, 59, 59);
        const raw = await read(session, (t) => getTimetable(session.key, t, first, end));
        const days = monthDays(raw);
        const afterMonth = addDays(end, 1);
        const later = Object.keys(days).length
            ? []
            : coursesView(await read(session, (t) => getTimetable(session.key, t, afterMonth, addDays(afterMonth, 49))));
        return { month, days, next: later[0]?.start ?? null };
    }

    async function agenda(session: Session, url: URL) {
        const month = url.searchParams.get('month');
        if (month !== null) return agendaMonth(session, month);
        const asked = url.searchParams.get('week') ?? '';
        const date = /^\d{4}-\d{2}-\d{2}$/.test(asked) ? new Date(`${asked}T12:00:00`) : new Date();
        if (Number.isNaN(date.getTime())) throw new HttpError(400, 'Date invalide.');
        const monday = getMonday(date);
        const end = addDays(monday, 6);
        end.setHours(23, 59, 59);
        const courses = coursesView(await read(session, (t) => getTimetable(session.key, t, monday, end)));
        // Semaine vide, fréquente en alternance : on indique où reprendre.
        const later = courses.length
            ? []
            : coursesView(await read(session, (t) => getTimetable(session.key, t, addDays(monday, 7), addDays(monday, 49))));
        return { start: monday.getTime(), courses, next: later[0]?.start ?? null };
    }

    /**
     * Adresse de la photo d'une personne que cet étudiant a le droit de voir : lui-même,
     * sa classe, ses intervenants, les membres de ses projets. MyGes répond sur n'importe quel identifiant :
     * sans ce contrôle, le panel deviendrait un annuaire de toute l'école. L'adresse vient
     * toujours de MyGes, jamais du navigateur.
     */
    async function photoAddress(session: Session, who: string): Promise<string | null> {
        if (who === 'moi' || Number(who) === session.uid) {
            const profile = await read(session, (t) => getProfile(session.key, t));
            return profile?._links?.photo?.href ?? null;
        }
        const id = Number(who);
        const classmates = await read(session, (t) => getClassmatePhotos(session.key, t));
        if (classmates[String(id)]) return classmates[String(id)];
        const teachers = await read(session, (t) => getTeacherPhotos(session.key, t));
        if (teachers[String(id)]) return teachers[String(id)];
        const assignments = await read(session, (t) => getAssignments(session.key, t));
        if (!teamMemberIds(assignments).has(id)) return null;
        return read(session, (t) => getStudentPhoto(session.key, t, id));
    }

    /** Relaie une photo sans l'écrire nulle part : ni disque, ni cache, ici comme dans le navigateur. */
    async function sendPhoto(req: http.IncomingMessage, res: http.ServerResponse, who: string) {
        const session = requireSession(req, photoRequests);
        const address = await photoAddress(session, who).catch((e) => {
            if (e instanceof HttpError && e.status === 401) throw e;
            return null;
        });
        const data = address ? await fetchPhotoBuffer(address, session.token, new Map()) : null;
        const type = data && imageType(data);
        if (!data || !type) throw new HttpError(404, 'Photo indisponible.');
        res.writeHead(200, { ...HEADERS, 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-store' });
        res.end(data);
    }

    /** Rejoint ou quitte une équipe, après avoir tout revérifié sur une lecture fraîche. */
    async function changeTeam(req: http.IncomingMessage, res: http.ServerResponse, id: string, teamId: string, action: string) {
        assertSameOrigin(req);
        await readJson(req);
        const session = requireSession(req);
        if (!teamChanges.hit(session.account)) throw new HttpError(429, 'Trop de changements d\'équipe. Réessaie plus tard.');

        forgetAssignments(session.key);
        const raw = await read(session, (t) => getAssignments(session.key, t));
        const detail = projectDetail(raw, id, session.uid);
        const team = detail?.teams.find((t) => t.id === teamId);
        if (!detail || !team) throw new HttpError(404, 'Équipe introuvable.');
        const joining = action === 'rejoindre';
        if (joining && (!detail.canJoin || team.full)) throw new HttpError(409, 'Cette équipe ne peut pas être rejointe.');
        if (!joining && (!detail.canLeave || !team.mine)) throw new HttpError(409, 'Tu ne peux pas quitter cette équipe.');

        const ids = [Number(detail.rcId), Number(id), Number(teamId)] as const;
        await read(session, async (t) => {
            try {
                await (joining ? ProjectService.joinProjectGroup(t, ...ids) : ProjectService.quitProjectGroup(t, ...ids));
            } catch (e) {
                // Une écriture n'est jamais rejouée : on dit simplement que MyGes a refusé.
                if (e instanceof MyGesError && e.status !== 401 && e.status < 500) throw new HttpError(409, 'MyGES a refusé cette action.');
                throw e;
            }
        });
        log('PANEL', `Équipe ${joining ? 'rejointe' : 'quittée'}.`);

        forgetAssignments(session.key);
        const fresh = await read(session, (t) => getAssignments(session.key, t));
        sendJson(res, 200, projectDetail(fresh, id, session.uid));
    }

    /**
     * Année demandée par `?year=` : l'une de celles que MyGes propose à cet étudiant.
     * Sans paramètre, l'année en cours.
     */
    async function askedYear(session: Session, url: URL): Promise<string> {
        const asked = url.searchParams.get('year');
        if (!asked) return getCurrentYear();
        if (!/^\d{4}$/.test(asked)) throw new HttpError(400, 'Année invalide.');
        const years = await read(session, (t) => getYears(session.key, t));
        if (!years.includes(asked)) throw new HttpError(404, 'Année indisponible.');
        return asked;
    }

    async function documents(session: Session, year: string) {
        const sources = courseSources(await read(session, (t) => getCourses(session.key, t, year)));
        return [{ id: ANNUAL, name: 'Documents annuels', hint: 'Calendriers, informations générales…' }, ...sources];
    }

    async function documentFiles(session: Session, source: string, url: URL) {
        // Les supports d'une matière ne dépendent que d'elle ; les documents annuels, de l'année.
        const year = source === ANNUAL ? await askedYear(session, url) : '';
        const payload = await read(session, (t) => (source === ANNUAL
            ? getAnnualDocuments(session.key, t, year)
            : getCourseFiles(session.key, t, source)));
        return toDocuments(payload);
    }

    async function sendFile(session: Session, url: URL, res: http.ServerResponse, fetchFile: (t: GesAuthenticationToken) => Promise<DownloadedFile>) {
        if (res.destroyed) return; // client parti pendant une lecture préalable
        const refused = acquireDownload(session.account);
        if (refused) throw new HttpError(429, refused);

        // La place n'est rendue qu'une fois MyGes lu ET le fichier remis, ou le client
        // parti : jusque-là, le fichier occupe la mémoire.
        let pending = 2;
        const done = () => {
            if (--pending === 0) releaseDownload(session.account);
        };
        const deadline = setTimeout(() => res.destroy(), DOWNLOAD_DEADLINE_MS);
        deadline.unref();
        res.once('close', () => {
            clearTimeout(deadline);
            done();
        });

        try {
            const { data, fileName } = await read(session, fetchFile);
            // Toujours en pièce jointe et sans type interprétable : un fichier HTML
            // déposé sur MyGes ne s'exécute pas sur l'origine du panel.
            const name = safeFileName(fileName || url.searchParams.get('name') || 'document');
            res.writeHead(200, {
                ...HEADERS,
                'Content-Type': 'application/octet-stream',
                'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
                'Content-Length': data.length,
                'Cache-Control': 'no-store',
            });
            res.end(data);
        } catch (e) {
            if (e instanceof FileTooLargeError) throw new HttpError(413, 'Fichier trop volumineux : récupère-le sur MyGES.');
            throw e;
        } finally {
            done();
        }
    }

    async function route(req: http.IncomingMessage, res: http.ServerResponse) {
        if (trustProxy && isDirectAccess(req.socket.remoteAddress ?? '', req.headers['x-forwarded-for'])) {
            throw new HttpError(403, 'Accès direct refusé. Utilise l\'adresse HTTPS du panel.');
        }
        let url: URL;
        try {
            url = new URL(req.url ?? '/', 'http://panel.invalid');
        } catch {
            throw new HttpError(400, 'Requête invalide.');
        }
        const file = statics.get(url.pathname);

        if ((req.method === 'GET' || req.method === 'HEAD') && file) {
            const caching = { ...HEADERS, 'Cache-Control': 'no-cache', ETag: file.etag, Vary: 'Accept-Encoding' };
            if (req.headers['if-none-match'] === file.etag) {
                res.writeHead(304, caching);
                res.end();
                return;
            }
            const compressed = /\bgzip\b(?!;q=0\b)/i.test(req.headers['accept-encoding'] ?? '') ? file.gzipped : null;
            const body = compressed ?? file.body;
            res.writeHead(200, { ...caching, 'Content-Type': file.type, 'Content-Length': body.length, ...(compressed ? { 'Content-Encoding': 'gzip' } : {}) });
            res.end(body);
            return;
        }
        if (req.method === 'POST' && url.pathname === '/api/login') return login(req, res);
        if (req.method === 'POST' && url.pathname === '/api/logout') return logout(req, res);
        const teamRoute = url.pathname.match(/^\/api\/projets\/([\w-]{1,40})\/equipes\/([\w-]{1,40})\/(rejoindre|quitter)$/);
        if (req.method === 'POST' && teamRoute) return changeTeam(req, res, teamRoute[1], teamRoute[2], teamRoute[3]);
        if (req.method !== 'GET') throw new HttpError(405, 'Méthode refusée.');

        const photoRoute = url.pathname.match(/^\/api\/photos\/(moi|\d{1,12})$/);
        if (photoRoute) return sendPhoto(req, res, photoRoute[1]);

        const session = () => requireSession(req);
        const fileRoute = url.pathname.match(/^\/api\/documents\/([\w-]{1,40})(?:\/([\w-]{1,40}))?$/);
        switch (url.pathname) {
            case '/api/session': return sendJson(res, 200, { name: session().name });
            case '/api/home': return sendJson(res, 200, await home(session()));
            case '/api/agenda': return sendJson(res, 200, await agenda(session(), url));
            case '/api/annees': {
                const s = session();
                return sendJson(res, 200, { current: getCurrentYear(), years: await read(s, (t) => getYears(s.key, t)) });
            }
            case '/api/notes': {
                const s = session();
                const year = await askedYear(s, url);
                return sendJson(res, 200, notesView(await read(s, (t) => getGrades(s.key, t, year))));
            }
            case '/api/absences': {
                const s = session();
                const year = await askedYear(s, url);
                // Les notes ne font qu'enrichir l'écran : leur panne ne prive pas des absences.
                const [absences, grades] = await Promise.all([
                    read(s, (t) => getAbsences(s.key, t, year)),
                    read(s, (t) => getGrades(s.key, t, year)).catch((e) => {
                        if (e instanceof HttpError && e.status === 401) throw e;
                        return [];
                    }),
                ]);
                return sendJson(res, 200, absencesView(absences, grades));
            }
            case '/api/projets': {
                const s = session();
                return sendJson(res, 200, projectsView(await read(s, (t) => getAssignments(s.key, t)), s.uid));
            }
            case '/api/evenements': {
                const s = session();
                return sendJson(res, 200, allEventsView(await read(s, (t) => getEvents(s.key, t))));
            }
            case '/api/annuaire': {
                const s = session();
                // Une liste indisponible n'empêche pas d'afficher l'autre. Un token refusé, si.
                const optional = <T>(load: Promise<T[]>) => load.catch((e): T[] => {
                    if (e instanceof HttpError && e.status === 401) throw e;
                    return [];
                });
                const [classmates, teachers] = await Promise.all([
                    optional(read(s, (t) => getClassmates(s.key, t))),
                    optional(read(s, (t) => getTeachers(s.key, t))),
                ]);
                return sendJson(res, 200, directoryView(classmates, teachers));
            }
            case '/api/profil': {
                const s = session();
                const [profile, classes] = await Promise.all([
                    read(s, (t) => getProfile(s.key, t)),
                    read(s, (t) => getClasses(s.key, t)).catch((e) => {
                        if (e instanceof HttpError && e.status === 401) throw e;
                        return [];
                    }),
                ]);
                return sendJson(res, 200, profileView(profile, classes));
            }
            case '/api/agenda.ics': {
                const s = session();
                const monday = getMonday(new Date());
                const end = addDays(monday, ICS_WEEKS * 7 - 1);
                end.setHours(23, 59, 59);
                const ics = buildIcs(await read(s, (t) => getTimetable(s.key, t, monday, end)));
                res.writeHead(200, {
                    ...HEADERS,
                    'Content-Type': 'text/calendar; charset=utf-8',
                    'Content-Disposition': 'attachment; filename="emploi-du-temps.ics"',
                    'Cache-Control': 'no-store',
                });
                res.end(ics);
                return;
            }
            case '/api/news': {
                const s = session();
                return sendJson(res, 200, newsView(await read(s, (t) => getNews(s.key, t))));
            }
            case '/api/documents': {
                const s = session();
                return sendJson(res, 200, await documents(s, await askedYear(s, url)));
            }
        }
        const syllabus = url.pathname.match(/^\/api\/courses\/([\w-]{1,40})\/syllabus$/);
        if (syllabus) {
            const s = session();
            return sendJson(res, 200, syllabusView(await read(s, (t) => getSyllabus(s.key, t, syllabus[1]))));
        }
        if (fileRoute?.[2]) {
            const [, source, id] = fileRoute;
            return sendFile(session(), url, res, (t) => (source === ANNUAL
                ? DocumentService.downloadAnnualDocument(t, id, MAX_FILE_BYTES)
                : DocumentService.downloadCourseFile(t, source, id, MAX_FILE_BYTES)));
        }
        const projectRoute = url.pathname.match(/^\/api\/projets\/([\w-]{1,40})(?:\/(consignes|depots)\/([\w-]{1,40}))?$/);
        if (projectRoute) {
            const s = session();
            const [, id, kind, fileId] = projectRoute;
            const detail = projectDetail(await read(s, (t) => getAssignments(s.key, t)), id, s.uid);
            if (!detail) throw new HttpError(404, 'Projet introuvable.');
            if (!kind) return sendJson(res, 200, detail);
            // Seuls les fichiers affichés à cet étudiant se téléchargent : MyGes servirait
            // peut-être aussi le dépôt d'un autre groupe à partir de son numéro.
            const allowed = kind === 'consignes' ? detail.files : detail.steps.flatMap((step) => step.files);
            if (!allowed.some((file) => file.id === fileId)) throw new HttpError(404, 'Fichier introuvable.');
            return sendFile(s, url, res, (t) => (kind === 'consignes'
                ? ProjectService.downloadProjectFile(t, fileId, MAX_FILE_BYTES)
                : ProjectService.downloadStepFile(t, fileId, MAX_FILE_BYTES)));
        }
        if (fileRoute) return sendJson(res, 200, await documentFiles(session(), fileRoute[1], url));
        throw new HttpError(404, 'Page introuvable.');
    }

    const handler: http.RequestListener = (req, res) => {
        route(req, res).catch((e) => {
            if (!(e instanceof HttpError)) logError('PANEL', 'Erreur inattendue :', e);
            if (res.headersSent) return void res.destroy();
            sendJson(res, e instanceof HttpError ? e.status : 500, { error: e instanceof HttpError ? e.message : 'Erreur interne.' });
        });
    };
    const server = tls
        ? https.createServer({ ...readTls(tls), minVersion: 'TLSv1.2' }, handler)
        : http.createServer(handler);
    if (tls) {
        // Un certificat d'adresse IP ne dure que 6 jours : son renouvellement ne doit
        // pas demander de redémarrage, qui déconnecterait tout le monde.
        const timer = setInterval(() => reloadTls(server as https.Server, tls), CERT_RELOAD_MS);
        timer.unref();
        server.once('close', () => clearInterval(timer));
    }
    // Un client lent ou muet ne doit pas garder une connexion ouverte.
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;
    server.keepAliveTimeout = 5_000;
    server.maxConnections = 500;
    return server;
}
