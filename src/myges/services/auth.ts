import { AccessToken } from '../types/auth';

export class AuthService {
  static async generateAccessToken(
    username: string,
    password: string,
  ): Promise<AccessToken | null> {
    const credentials = btoa(`${username}:${password}`);

    const response = await fetch(
      'https://authentication.kordis.fr/oauth/authorize?response_type=token&client_id=skolae-app',
      {
        method: 'GET',
        headers: {
          Authorization: `Basic ${credentials}`,
        },
        redirect: 'manual',
      }
    );

    const location = response.headers.get('location');
    if (!location) {
      throw new Error('Bad password');
    }

    const hash = location.slice(location.indexOf('#') + 1);
    const properties = hash
      .split('&')
      .map((property) => property.split('='))
      .reduce<Record<string, string>>(
        (acc, [name, value]) => ({ ...acc, [name]: value }),
        {},
      );

    return {
      access_token: properties.access_token,
      token_type: properties.token_type,
      expires_in: properties.expires_in,
      scope: properties.scope,
      uid: properties.uid,
    };
  }
}