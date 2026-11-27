import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { LoungeApiErrorDto, LoungePaginationQueryDto } from '@rebecca/types';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import {
  DISCLAIMER_RECONSENT_REQUIRED_CODE,
  LoungeClientApiError,
  LoungeReconsentRequiredClientError,
} from '../../core/errors/lounge-client.errors';

/**
 * Shared Angular HTTP transport and BFF error-mapping helper used exclusively by thin
 * per-port HTTP adapters under `infrastructure/http/`.
 */
@Injectable({ providedIn: 'root' })
export class LoungeHttpClientHelper {
  private readonly http = inject(HttpClient);
  private readonly apiBaseUrl = environment.apiBaseUrl;
  private activeDisclaimerVersion: number = environment.disclaimerVersion;

  /** Caches the server-supplied disclaimer version for HTTP 428 error fallback mapping. */
  public setActiveDisclaimerVersion(version: number): void {
    this.activeDisclaimerVersion = version;
  }

  /** Executes an HTTP GET against the Private Lounge BFF with typed error mapping. */
  public async get<T>(
    path: string,
    options?: {
      readonly params?: HttpParams;
      readonly headers?: Record<string, string>;
    },
  ): Promise<T> {
    try {
      return await firstValueFrom(this.http.get<T>(`${this.apiBaseUrl}${path}`, options));
    } catch (err) {
      throw this.mapHttpError(err);
    }
  }

  /** Executes an HTTP POST against the Private Lounge BFF with typed error mapping. */
  public async post<T>(path: string, body: unknown): Promise<T> {
    try {
      return await firstValueFrom(this.http.post<T>(`${this.apiBaseUrl}${path}`, body));
    } catch (err) {
      throw this.mapHttpError(err);
    }
  }

  /** Executes an HTTP PATCH against the Private Lounge BFF with typed error mapping. */
  public async patch<T>(path: string, body: unknown): Promise<T> {
    try {
      return await firstValueFrom(this.http.patch<T>(`${this.apiBaseUrl}${path}`, body));
    } catch (err) {
      throw this.mapHttpError(err);
    }
  }

  /** Executes an HTTP DELETE against the Private Lounge BFF with typed error mapping. */
  public async delete<T>(path: string, body?: unknown): Promise<T> {
    try {
      return await firstValueFrom(
        this.http.delete<T>(`${this.apiBaseUrl}${path}`, body !== undefined ? { body } : undefined),
      );
    } catch (err) {
      throw this.mapHttpError(err);
    }
  }

  /** Builds standard bounded pagination query parameters cleanly without undefined entries. */
  public buildPaginationParams(query?: LoungePaginationQueryDto): HttpParams {
    let params = new HttpParams();
    if (query?.page !== undefined) {
      params = params.set('page', String(query.page));
    }
    if (query?.limit !== undefined) {
      params = params.set('limit', String(query.limit));
    }
    if (query?.cursor) {
      params = params.set('cursor', query.cursor);
    }
    return params;
  }

  /** Maps Angular `HttpErrorResponse` payloads into domain-typed `LoungeClientApiError` instances. */
  public mapHttpError(err: unknown): Error {
    if (err instanceof HttpErrorResponse) {
      const payload =
        typeof err.error === 'object' && err.error !== null
          ? (err.error as Partial<LoungeApiErrorDto>)
          : null;
      const errorCode = typeof payload?.code === 'string' ? payload.code : undefined;
      if (errorCode === DISCLAIMER_RECONSENT_REQUIRED_CODE) {
        return new LoungeReconsentRequiredClientError(
          typeof payload?.requiredDisclaimerVersion === 'number'
            ? payload.requiredDisclaimerVersion
            : this.activeDisclaimerVersion,
          typeof payload?.acceptedDisclaimerVersion === 'number'
            ? payload.acceptedDisclaimerVersion
            : 0,
        );
      }
      const message =
        typeof payload?.error === 'string' && payload.error.trim().length > 0
          ? payload.error.trim()
          : err.status > 0
            ? `HTTP ${err.status}`
            : 'Network request failed';
      return new LoungeClientApiError(err.status, message, errorCode, { cause: err });
    }
    if (err instanceof Error) {
      return err;
    }
    return new Error('Unexpected Private Lounge BFF client error', { cause: err });
  }
}
