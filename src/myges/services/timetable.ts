import { BaseService } from './base';
import { TimetableItem } from '../interfaces/timetable';
import { GesAuthenticationToken } from '../types/auth';

export class TimetableService extends BaseService {
  static getTimetable(credentials: GesAuthenticationToken, start: Date, end: Date) {
    return this.get<TimetableItem[]>(
      credentials,
      `/me/agenda?start=${start.valueOf()}&end=${end.valueOf()}`,
    );
  }
}