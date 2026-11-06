import { BaseService } from './base';
import { GesAuthenticationToken } from '../types/auth';

export class DocumentService extends BaseService {
  /** Supports d'une matière ; `rcId` est le `rc_id` renvoyé par /me/{year}/courses. */
  static getCourseFiles(credentials: GesAuthenticationToken, rcId: string) {
    return this.get(credentials, `/me/${encodeURIComponent(rcId)}/files`);
  }

  static downloadCourseFile(credentials: GesAuthenticationToken, rcId: string, fileId: string, maxBytes: number) {
    return this.download(credentials, `/me/${encodeURIComponent(rcId)}/files/${encodeURIComponent(fileId)}`, maxBytes);
  }

  /** Documents annuels de l'école (calendriers, informations générales…). */
  static getAnnualDocuments(credentials: GesAuthenticationToken, year: string) {
    return this.get(credentials, `/me/${year}/annualDocuments`);
  }

  static downloadAnnualDocument(credentials: GesAuthenticationToken, id: string, maxBytes: number) {
    return this.download(credentials, `/me/annualDocuments/${encodeURIComponent(id)}`, maxBytes);
  }
}
