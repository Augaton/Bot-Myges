import { GesAuthenticationToken } from './types/auth';
import { AuthService } from './services/auth';

export class GesAPI {
  /** Lève BadCredentialsError si MyGes refuse les identifiants, MyGesError s'il est en panne. */
  static async login(username: string, password: string): Promise<GesAuthenticationToken> {
    const token = await AuthService.generateAccessToken(username, password);
    const ttl = Number(token.expires_in);

    return {
      token_type: token.token_type,
      access_token: token.access_token,
      expires_at: Number.isFinite(ttl) && ttl > 0 ? Date.now() + ttl * 1000 : undefined,
    };
  }
}
