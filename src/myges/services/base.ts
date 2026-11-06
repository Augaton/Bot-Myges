import { GesAuthenticationToken } from '../types/auth';
import { FileTooLargeError, MyGesError } from '../errors';
import { log } from '../../utils/logger';

export interface RequestConfig {
  headers?: Record<string, string>;
  body?: any;
}

const API_URL = 'https://api.kordis.fr';

// `fetch` n'a aucun délai maximal par défaut : une API MyGes qui accepte la
// connexion sans jamais répondre bloquerait la commande indéfiniment (et, pour
// les tâches de fond, le cycle entier).
const REQUEST_TIMEOUT_MS = 15_000;
// Bien au-delà de toute réponse réelle : une réponse démesurée ne doit pas pouvoir
// faire tomber le processus.
const MAX_JSON_BYTES = 5 * 1024 * 1024;
// Un fichier de cours prend plus de temps qu'une réponse JSON.
const DOWNLOAD_TIMEOUT_MS = 60_000;

// MyGes renvoie régulièrement des 500/502/503 passagers. Une lecture (GET) est
// rejouée jusqu'à 2 fois avec un délai croissant. Les écritures ne le sont
// jamais : rejouer un POST pourrait, par exemple, envoyer un message deux fois.
const MAX_ATTEMPTS = 3;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
// Au-delà de ce temps passé, on renonce plutôt que de faire patienter l'utilisateur.
const RETRY_BUDGET_MS = 25_000;

// Le token est renouvelé un peu avant son expiration annoncée, plutôt que
// d'attendre d'essuyer un refus.
const EXPIRY_MARGIN_MS = 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Délai avant de rejouer : Retry-After si fourni, sinon ~0,5 s puis ~1,5 s. */
function backoff(attempt: number, retryAfter: string | null): number {
  const asked = Number(retryAfter);
  if (Number.isFinite(asked) && asked > 0) return Math.min(asked * 1000, 5_000);
  return 500 * 3 ** (attempt - 1) + Math.random() * 250;
}

/** Remplace le token par un neuf. Faux si la reconnexion est impossible. */
async function renew(credentials: GesAuthenticationToken): Promise<boolean> {
  if (!credentials.__refresh) return false;
  const fresh = await credentials.__refresh();
  if (!fresh) return false;
  credentials.token_type = fresh.token_type;
  credentials.access_token = fresh.access_token;
  credentials.expires_at = fresh.expires_at;
  return true;
}

/** Nom de fichier annoncé par Content-Disposition (forme encodée RFC 5987 d'abord). */
function dispositionFileName(header: string | null): string | null {
  if (!header) return null;
  const encoded = header.match(/filename\*=(?:UTF-8'[^']*')?([^;]+)/i);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].trim());
    } catch {
      /* encodage invalide : on se rabat sur la forme simple */
    }
  }
  return header.match(/filename="?([^";]+)"?/i)?.[1]?.trim() || null;
}

/**
 * Lit un corps de réponse sans jamais dépasser `maxBytes` : il est lu au fil de
 * l'eau et abandonné dès que la limite est franchie. Lève FileTooLargeError au-delà.
 */
export async function readBounded(response: Response, maxBytes: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new FileTooLargeError();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > maxBytes) throw new FileTooLargeError(); // quitter la boucle annule le flux
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export interface DownloadedFile {
  data: Buffer;
  /** Nom annoncé par MyGes, à assainir avant usage (donnée non fiable). */
  fileName: string | null;
}

export abstract class BaseService {
  /** Requête JSON : renvoie `result`, ou null si MyGes répond sans corps (204). */
  static async request<T = any>(
    credentials: GesAuthenticationToken,
    method: string,
    url: string,
    request_config: RequestConfig = {},
  ): Promise<T> {
    const response = await this.send(credentials, method, url, request_config, REQUEST_TIMEOUT_MS);
    const body = await readBounded(response, MAX_JSON_BYTES);
    return (body.length ? (JSON.parse(body.toString('utf-8')) as { result: T }).result : null) as T;
  }

  /**
   * Télécharge un fichier en mémoire, sans jamais dépasser `maxBytes`. Lève
   * FileTooLargeError au-delà, MyGesError si MyGes renvoie un fichier vide ou une
   * page HTML (redirection vers le portail de connexion).
   */
  static async download(credentials: GesAuthenticationToken, url: string, maxBytes: number): Promise<DownloadedFile> {
    const response = await this.send(credentials, 'GET', url, {}, DOWNLOAD_TIMEOUT_MS);

    if (response.headers.get('content-type')?.toLowerCase().includes('text/html')) {
      await response.body?.cancel().catch(() => {});
      throw new MyGesError(response.status, `MyGes a renvoyé une page HTML à la place du fichier (GET ${url})`);
    }
    const data = await readBounded(response, maxBytes);
    if (!data.length) throw new MyGesError(response.status, `MyGes a renvoyé un fichier vide (GET ${url})`);
    return { data, fileName: dispositionFileName(response.headers.get('content-disposition')) };
  }

  /** Envoie la requête (reconnexion et nouvelles tentatives comprises) ; lève si elle échoue. */
  private static async send(
    credentials: GesAuthenticationToken,
    method: string,
    url: string,
    request_config: RequestConfig,
    timeoutMs: number,
  ): Promise<Response> {
    const { headers = {}, body } = request_config;
    const idempotent = method === 'GET';
    const started = Date.now();
    const canRetry = (attempt: number) => attempt < MAX_ATTEMPTS && Date.now() - started < RETRY_BUDGET_MS;

    // Un seul renouvellement par requête : si le token neuf est refusé aussi,
    // insister ne servirait à rien.
    let renewed = false;
    if (credentials.expires_at && Date.now() > credentials.expires_at - EXPIRY_MARGIN_MS) {
      renewed = await renew(credentials);
    }

    for (let attempt = 1; ; attempt++) {
      const usedToken = credentials.access_token;
      let response: Response;
      try {
        response = await fetch(`${API_URL}${url}`, {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...headers,
            Authorization: `${credentials.token_type} ${credentials.access_token}`,
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e: any) {
        // Réseau coupé ou délai dépassé : rejouable pour une lecture uniquement.
        if (idempotent && canRetry(attempt)) {
          log('MYGES', `${method} ${url} : ${e?.name ?? 'erreur réseau'}, nouvelle tentative (${attempt}/${MAX_ATTEMPTS - 1})`);
          await sleep(backoff(attempt, null));
          continue;
        }
        throw e;
      }

      if (response.ok) return response;

      // Un corps de réponse jamais lu retient sa connexion jusqu'au passage du
      // ramasse-miettes : sur un bot qui tourne des semaines, ça s'accumule.
      await response.body?.cancel().catch(() => {});

      // Token expiré : reconnexion automatique (une seule fois), puis on rejoue.
      // Si une requête concurrente l'a déjà renouvelé, on rejoue directement.
      if (response.status === 401 && !renewed) {
        renewed = credentials.access_token !== usedToken || (await renew(credentials));
        if (renewed) continue;
      }

      if (idempotent && RETRY_STATUSES.has(response.status) && canRetry(attempt)) {
        const wait = backoff(attempt, response.headers.get('retry-after'));
        log('MYGES', `${method} ${url} : HTTP ${response.status}, nouvelle tentative dans ${Math.round(wait)} ms (${attempt}/${MAX_ATTEMPTS - 1})`);
        await sleep(wait);
        continue;
      }

      throw new MyGesError(response.status, `MyGes a répondu HTTP ${response.status} (${method} ${url})`);
    }
  }

  protected static get<T = any>(credentials: GesAuthenticationToken, url: string) {
    return this.request<T>(credentials, 'GET', url);
  }

  protected static post<T = any>(credentials: GesAuthenticationToken, url: string, request_config: RequestConfig = {}) {
    return this.request<T>(credentials, 'POST', url, request_config);
  }

  protected static put<T = any>(credentials: GesAuthenticationToken, url: string, request_config: RequestConfig = {}) {
    return this.request<T>(credentials, 'PUT', url, request_config);
  }

  protected static delete<T = any>(credentials: GesAuthenticationToken, url: string) {
    return this.request<T>(credentials, 'DELETE', url);
  }
}
