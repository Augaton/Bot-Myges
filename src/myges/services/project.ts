import { BaseService } from './base';
import { Project } from '../interfaces/project';
import { GesAuthenticationToken } from '../types/auth';

export class ProjectService extends BaseService {
  static getProjects(credentials: GesAuthenticationToken, year: string) {
    return this.get(credentials, `/me/${year}/projects`);
  }

  /** Travaux pratiques : même structure que les projets (étapes, échéances). */
  static getPracticals(credentials: GesAuthenticationToken, year: string) {
    return this.get(credentials, `/me/${year}/practicals`);
  }

  static getProject(credentials: GesAuthenticationToken, id: string) {
    return this.get<Project>(credentials, `/me/projects/${id}`);
  }

  static getNextProjectSteps(credentials: GesAuthenticationToken) {
    return this.get(credentials, '/me/nextProjectSteps');
  }

  static joinProjectGroup(
    credentials: GesAuthenticationToken,
    projectRcId: number,
    projectId: number,
    projectGroupId: number,
  ) {
    return this.post(
      credentials,
      `/me/courses/${projectRcId}/projects/${projectId}/groups/${projectGroupId}`,
    );
  }

  static quitProjectGroup(
    credentials: GesAuthenticationToken,
    projectRcId: number,
    projectId: number,
    projectGroupId: number,
  ) {
    return this.delete(
      credentials,
      `/me/courses/${projectRcId}/projects/${projectId}/groups/${projectGroupId}`,
    );
  }

  static getProjectGroupMessages(credentials: GesAuthenticationToken, projectGroupId: number) {
    return this.get(credentials, `/me/projectGroups/${projectGroupId}/messages`);
  }

  static sendProjectGroupMessage(credentials: GesAuthenticationToken, projectGroupId: number, message: string) {
    return this.post(credentials, `/me/projectGroups/${projectGroupId}/messages`, {
      body: {
        projectGroupId,
        message,
      },
    });
  }
}