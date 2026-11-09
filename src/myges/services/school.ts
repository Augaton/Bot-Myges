import { BaseService } from './base';
import { GesAuthenticationToken } from '../types/auth';

export class SchoolService extends BaseService {
  
  static getEvents(credentials: GesAuthenticationToken) {
    return this.get(credentials, '/me/events');
  }

  static getNews(credentials: GesAuthenticationToken) {
    return this.get(credentials, '/me/news?page=0&size=10');
  }

  static getTeachers(credentials: GesAuthenticationToken, year: string) {
    return this.get(credentials, `/me/${year}/teachers`);
  }

  static getMyClasses(credentials: GesAuthenticationToken, year: string) {
    return this.get(credentials, `/me/${year}/classes`);
  }

  /** Fiche d'un étudiant. MyGes accepte n'importe quel identifiant : à n'appeler que pour un proche vérifié. */
  static getStudent(credentials: GesAuthenticationToken, id: number) {
    return this.get(credentials, `/me/students/${id}`);
  }

  static getClassmates(credentials: GesAuthenticationToken, classId: number) {
    return this.get(credentials, `/me/classes/${classId}/students`);
  }
}