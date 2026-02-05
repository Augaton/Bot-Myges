import { BaseService } from './base';
import { GesAuthenticationToken } from '../types/auth';

export class SchoolService extends BaseService {
  
  static getNews(credentials: GesAuthenticationToken) {
    return this.get(credentials, '/me/news?page=0&size=10');
  }

  static getTeachers(credentials: GesAuthenticationToken, year: string) {
    return this.get(credentials, `/me/${year}/teachers`);
  }

  static getMyClasses(credentials: GesAuthenticationToken, year: string) {
    return this.get(credentials, `/me/${year}/classes`);
  }

  static getClassmates(credentials: GesAuthenticationToken, classId: number) {
    return this.get(credentials, `/classes/${classId}/students`);
  }
}