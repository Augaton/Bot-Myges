import { GesAuthenticationToken } from '../types/auth';
import { MyGesError } from '../errors';
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

export abstract class BaseService {
  static async request<T = any>(
    credentials: GesAuthenticationToken,
    method: string,
    url: string,
    request_config: RequestConfig = {},
  ): Promise<T> {
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
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

      if (response.ok) {
        const data = (await response.json()) as { result: T };
        return data.result;
      }

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
