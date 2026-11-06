// En authentification Basic, tout ce qui suit le premier « : » est le mot de passe.
// « cible:essai » viserait donc « cible » tout en comptant les tentatives sur un
// identifiant chaque fois différent, ce qui contournerait les limites d'essais.
// Les caractères invisibles sont refusés pour la même raison.
export const VALID_USERNAME = /^[^\s:\p{Cc}\p{Cf}]+$/u;

/**
 * Forme canonique d'un identifiant MyGes, pour compter les essais : « P.Nom »,
 * « p.nom » et leurs variantes accentuées ou combinantes sont un même compte.
 */
export const accountKey = (username: string) => username.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
