export interface AccessToken {
  access_token: string;
  token_type: string;
  expires_in: string;
  scope: string;
  uid: string;
}

export interface GesAuthenticationToken {
  token_type: string;
  access_token: string;
  /** Expiration annoncée par MyGes (ms depuis l'epoch), si elle est connue. */
  expires_at?: number;
  /**
   * Optionnel : fonction de rafraîchissement appelée automatiquement par
   * BaseService lorsqu'un appel renvoie 401 (token expiré) ou que le token
   * arrive à expiration. Doit renvoyer un nouveau token, ou null si la
   * reconnexion est impossible.
   */
  __refresh?: () => Promise<GesAuthenticationToken | null>;
}
