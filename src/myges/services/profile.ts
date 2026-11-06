import { BaseService } from './base';
import { GesAuthenticationToken } from '../types/auth';

export class ProfileService extends BaseService {
  /** Compte connecté, dont son rôle (`normalized_role` : « student » pour un étudiant). */
  static getAccount(credentials: GesAuthenticationToken) {
    return this.get(credentials, '/me');
  }

  /** Syllabus d'une matière ; `rcId` est le `rc_id` de la matière. */
  static getSyllabus(credentials: GesAuthenticationToken, rcId: string) {
    return this.get(credentials, `/me/${encodeURIComponent(rcId)}/syllabus`);
  }

  static getYears(credentials: GesAuthenticationToken) {
    return this.get(credentials, '/me/years');
  }

  static getProfile(credentials: GesAuthenticationToken) {
    return this.get(credentials, '/me/profile');
  }

  static getAbsences(credentials: GesAuthenticationToken, year: string) {
    return this.get(credentials, `/me/${year}/absences`);
  }

  static getGrades(credentials: GesAuthenticationToken, year: string) {
    return this.get(credentials, `/me/${year}/grades`);
  }

  static getCourses(credentials: GesAuthenticationToken, year: string) {
    return this.get(credentials, `/me/${year}/courses`);
  }
}