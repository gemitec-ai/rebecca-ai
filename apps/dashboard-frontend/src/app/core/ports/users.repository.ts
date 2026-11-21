import { InjectionToken } from '@angular/core';
import { Observable } from 'rxjs';
import { UserDetail, UserStatus, PaginatedResponse, ChatMessage } from '@rebecca/types';

export interface UsersRepository {
  getAll(params?: { page?: number; limit?: number; search?: string; sortBy?: string; sortOrder?: 'asc' | 'desc'; }): Observable<PaginatedResponse<UserDetail>>;
  getById(id: string): Observable<UserDetail>;
  getConversations(id: string, params?: { page?: number; limit?: number; sortOrder?: 'asc' | 'desc'; }): Observable<PaginatedResponse<ChatMessage>>;
  updateMemory(id: string, coreProfile: string): Observable<unknown>;
  bulkUpdateStatus(ids: string[], status: UserStatus): Observable<unknown>;
}

export const USERS_REPOSITORY = new InjectionToken<UsersRepository>('UsersRepository');
