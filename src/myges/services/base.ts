import { GesAuthenticationToken } from '../types/auth';

export interface RequestConfig {
  headers?: Record<string, string>;
  body?: any;
}

export abstract class BaseService {
  static async request<T = any>(
    credentials: GesAuthenticationToken,
    method: string,
    url: string,
    request_config: RequestConfig = {},
  ) {
    const { headers = {}, body } = request_config;
    const response = await fetch(`https://api.kordis.fr${url}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
        Authorization: `${credentials.token_type} ${credentials.access_token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
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