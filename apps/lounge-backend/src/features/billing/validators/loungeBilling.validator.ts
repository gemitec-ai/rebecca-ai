import type {
  LoungeCreateCheckoutRequestDto,
  LoungeCreatePortalRequestDto,
  LoungeEuWithdrawalRequestDto,
  LoungePortalFlow,
  LoungeProductId,
} from '@rebecca/types';
import { LoungeValidationError } from '../../../utils/errors';

const SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_]{1,250}$/;
const CHARGE_ID_PATTERN = /^ch_[A-Za-z0-9_]{1,250}$/;
const PURCHASABLE_PRODUCT_IDS: ReadonlyArray<Exclude<LoungeProductId, 'WELCOME_BONUS_20'>> = [
  'TRIAL_TICKET_100',
  'CHARGE_TICKET_100',
  'STANDARD_MONTHLY',
];
const PORTAL_FLOWS: readonly LoungePortalFlow[] = [
  'default',
  'payment_method_update',
  'subscription_cancel',
];

/** Validates incoming Checkout creation payloads (unchecked ASCT Art. 12-6 checkboxes enforced `true`). */
export function parseAndValidateCreateCheckoutRequest(
  raw: unknown,
): LoungeCreateCheckoutRequestDto {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new LoungeValidationError('Checkout payload must be a JSON object');
  }
  const body = raw as Record<string, unknown>;
  const rawProductId = body['productId'];
  const productId = PURCHASABLE_PRODUCT_IDS.find((id) => id === rawProductId);
  if (!productId) {
    throw new LoungeValidationError('Invalid or unsupported productId');
  }
  if (
    body['acceptedPurchaseDisclosure'] !== true ||
    body['acceptedAutoRenewalOptIn'] !== true ||
    body['confirmedAdultOrParentalConsent'] !== true
  ) {
    throw new LoungeValidationError(
      'All statutory pre-checkout disclosures and confirmations must be accepted',
    );
  }
  if (body['euDigitalWaiverAccepted'] !== undefined && typeof body['euDigitalWaiverAccepted'] !== 'boolean') {
    throw new LoungeValidationError('Field "euDigitalWaiverAccepted" must be a boolean');
  }
  return {
    productId,
    acceptedPurchaseDisclosure: true,
    acceptedAutoRenewalOptIn: true,
    confirmedAdultOrParentalConsent: true,
    ...(typeof body['euDigitalWaiverAccepted'] === 'boolean'
      ? { euDigitalWaiverAccepted: body['euDigitalWaiverAccepted'] }
      : {}),
  };
}

/** Validates `POST /billing/checkout/verify` request payload. */
export function parseAndValidateVerifyCheckoutRequest(raw: unknown): { readonly sessionId: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new LoungeValidationError('Checkout verify payload must be a JSON object');
  }
  const sessionId = (raw as Record<string, unknown>)['sessionId'];
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId.trim())) {
    throw new LoungeValidationError('Field "sessionId" must be a valid Stripe Checkout Session ID');
  }
  return { sessionId: sessionId.trim() };
}

/** Validates `POST /billing/portal` deep-link flow selector. */
export function parseAndValidatePortalRequest(raw: unknown): LoungeCreatePortalRequestDto {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new LoungeValidationError('Portal payload must be a JSON object');
  }
  const rawFlow = (raw as Record<string, unknown>)['flow'];
  const flow = PORTAL_FLOWS.find((f) => f === rawFlow);
  if (!flow) {
    throw new LoungeValidationError(
      'Field "flow" must be one of: default, payment_method_update, subscription_cancel',
    );
  }
  return { flow };
}

/** Validates Phase 2 EEA withdrawal payload (`POST /billing/eu-withdrawal`). */
export function parseAndValidateEuWithdrawalRequest(
  raw: unknown,
): LoungeEuWithdrawalRequestDto {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new LoungeValidationError('EU withdrawal payload must be a JSON object');
  }
  const body = raw as Record<string, unknown>;
  const targetType =
    body['targetType'] === 'SUBSCRIPTION' || body['targetType'] === 'CREDIT_LOT'
      ? body['targetType']
      : null;
  if (!targetType) {
    throw new LoungeValidationError('Field "targetType" must be SUBSCRIPTION or CREDIT_LOT');
  }
  const targetId = typeof body['targetId'] === 'string' ? body['targetId'].trim() : '';
  if (!targetId) {
    throw new LoungeValidationError('Field "targetId" must be a non-empty identifier');
  }
  if (body['confirmedWithdrawal'] !== true) {
    throw new LoungeValidationError('Field "confirmedWithdrawal" must be true');
  }
  return {
    targetType,
    targetId,
    confirmedWithdrawal: true,
  };
}

/** Validates bounded `[1, 30]` order listing pagination parameters (`GET /billing/orders`). */
export function parseOrdersQueryParams(rawQuery: Readonly<Record<string, unknown>>): {
  readonly limit: number;
  readonly startingAfter?: string;
} {
  const rawLimit = rawQuery['limit'];
  let limit = 20;
  if (rawLimit !== undefined && rawLimit !== null && rawLimit !== '') {
    if (Array.isArray(rawLimit) || (typeof rawLimit !== 'number' && typeof rawLimit !== 'string')) {
      throw new LoungeValidationError('Query parameter "limit" must be a positive integer');
    }
    const parsed = typeof rawLimit === 'number' ? rawLimit : Number(rawLimit);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
      throw new LoungeValidationError('Query parameter "limit" must be a positive integer');
    }
    limit = Math.min(parsed, 30);
  }

  const rawCursor = rawQuery['startingAfter'];
  let startingAfter: string | undefined;
  if (rawCursor !== undefined && rawCursor !== null && rawCursor !== '') {
    if (typeof rawCursor !== 'string' || !CHARGE_ID_PATTERN.test(rawCursor.trim())) {
      throw new LoungeValidationError('Query parameter "startingAfter" must be a Stripe Charge ID');
    }
    startingAfter = rawCursor.trim();
  }

  return { limit, ...(startingAfter ? { startingAfter } : {}) };
}
