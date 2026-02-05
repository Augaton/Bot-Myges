import { BaseService } from './base';
import { GesAuthenticationToken } from '../types/auth';

export class ProfileService extends BaseService {
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