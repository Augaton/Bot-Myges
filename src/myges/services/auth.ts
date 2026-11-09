import { AccessToken } from '../types/auth';
import { BadCredentialsError, MyGesError } from '../errors';

const AUTH_URL = 'https://authentication.kordis.fr/oauth/authorize?response_type=token&client_id=skolae-app';

// Sans délai maximal, un serveur d'authentification qui ne répond plus bloquait
// /login et toute reconnexion indéfiniment.
const AUTH_TIMEOUT_MS = 15_000;

export class AuthService {
  static async generateAccessToken(username: string, password: string): Promise<AccessToken> {
    // btoa lève une erreur au-delà du Latin-1 : un mot de passe avec « € » passait
    // pour une panne de MyGes. Le Latin-1 reste encodé comme il l'a toujours été.
    const pair = `${username}:${password}`;
    const credentials = /^[\0-\xff]*$/.test(pair) ? btoa(pair) : Buffer.from(pair, 'utf-8').toString('base64');

    const response = await fetch(AUTH_URL, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${credentials}`,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
    // Le corps ne sert jamais : on le libère pour rendre la connexion au pool.
    await response.body?.cancel().catch(() => {});

    const location = response.headers.get('location');
    if (!location) {
      // Seul un 401 veut dire « mauvais mot de passe ». Une panne (5xx), un excès
      // de requêtes (429) ou un refus du pare-feu de Kordis (403) n'ont rien à voir
      // avec le compte : les confondre bloquerait la session jusqu'au prochain
      // /login et ferait croire à l'utilisateur que son mot de passe a changé.
      if (response.status === 401) throw new BadCredentialsError();
      throw new MyGesError(response.status, `Authentification MyGes indisponible (HTTP ${response.status})`);
    }

    // Le token est dans le fragment de l'URL de redirection : #access_token=…&token_type=…
    // Valeurs gardées brutes (pas de décodage) : un token peut contenir des « + ».
    const hash = location.slice(location.indexOf('#') + 1);
    const properties = Object.fromEntries(
      hash.split('&').map((property) => {
        const i = property.indexOf('=');
        return i === -1 ? [property, ''] : [property.slice(0, i), property.slice(i + 1)];
      }),
    );

    if (!properties.access_token) {
      // Un refus explicite (RFC 6749, §4.2.2.1) vise le compte. Toute autre redirection
      // (page de maintenance, par exemple) n'en dit rien : la prendre pour un mauvais mot
      // de passe bloquerait la session jusqu'au prochain /login.
      if (/[?#&]error=/.test(location)) throw new BadCredentialsError();
      throw new MyGesError(response.status, 'Authentification MyGes indisponible (redirection sans token)');
    }

    return {
      access_token: properties.access_token,
      token_type: properties.token_type || 'bearer',
      expires_in: properties.expires_in,
      scope: properties.scope,
      uid: properties.uid,
    };
  }
}
