import { GesAuthenticationToken } from './types/auth';
import { AuthService } from './services/auth';

export class GesAPI {
  static async login(username: string, password: string): Promise<GesAuthenticationToken> {
    const token = await AuthService.generateAccessToken(username, password);

    if (!token) {
      throw new Error('Bad credentials');
    }

    return {
      token_type: token.token_type,
      access_token: token.access_token,
    };
  }
}