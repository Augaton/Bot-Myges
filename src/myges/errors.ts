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

/** Fichier MyGes trop lourd pour être envoyé sur Discord. */
export class FileTooLargeError extends Error {
  constructor() {
    super('Fichier trop volumineux');
    this.name = 'FileTooLargeError';
  }
}
