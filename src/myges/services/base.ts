import { GesAuthenticationToken } from '../types/auth';

export interface RequestConfig {
  headers?: Record<string, string>;
  body?: any;
}

// `fetch` n'a aucun délai maximal par défaut : une API MyGes qui accepte la
// connexion sans jamais répondre bloquerait la commande indéfiniment (et, pour
// les tâches de fond, le cycle entier). 20 s laissent large sans jamais figer.
const REQUEST_TIMEOUT_MS = 20_000;

export abstract class BaseService {
  static async request<T = any>(
    credentials: GesAuthenticationToken,
    method: string,
    url: string,
    request_config: RequestConfig = {},
    _retried = false,
  ): Promise<T> {
    const { headers = {}, body } = request_config;
    const response = await fetch(`https://api.kordis.fr${url}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
        Authorization: `${credentials.token_type} ${credentials.access_token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      // Token expiré : on tente une reconnexion automatique (une seule fois)
      // puis on rejoue la requête avec le nouveau token.
      if (response.status === 401 && !_retried && credentials.__refresh) {
        const fresh = await credentials.__refresh();
        if (fresh) {
          credentials.token_type = fresh.token_type;
          credentials.access_token = fresh.access_token;
          return this.request<T>(credentials, method, url, request_config, true);
        }
      }
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = (await response.json()) as { result: T };
    return data.result;
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