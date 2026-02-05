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
}