/** Réponse en erreur de l'API MyGes (après les éventuelles nouvelles tentatives). */
export class MyGesError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'MyGesError';
    this.status = status;
  }
}

/** Identifiant ou mot de passe refusé par MyGes (à distinguer d'une panne). */
export class BadCredentialsError extends Error {
  constructor() {
    super('Identifiants MyGes refusés');
    this.name = 'BadCredentialsError';
  }
}
