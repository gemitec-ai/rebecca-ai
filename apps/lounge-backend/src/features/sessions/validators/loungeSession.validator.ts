import type { LoungeSendMessageRequestDto } from '@rebecca/types';
import { LoungeValidationError } from '../../../utils/errors';

/** Maximum allowed length of a single user prompt in characters (cost & token guardrail). */
export const MAX_LOUNGE_MESSAGE_LENGTH = 1500;

/**
 * Validates and whitelists incoming Private Lounge chat turn request bodies at the trust boundary.
 *
 * @throws LoungeValidationError When payload is non-object, missing `content`, blank, or exceeds `MAX_LOUNGE_MESSAGE_LENGTH`.
 */
export function parseAndValidateSendMessageRequest(raw: unknown): LoungeSendMessageRequestDto {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new LoungeValidationError('Request payload must be a JSON object');
  }
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate['content'] !== 'string') {
    throw new LoungeValidationError('Field "content" must be a string');
  }
  const trimmed = candidate['content'].trim();
  if (!trimmed) {
    throw new LoungeValidationError('Message content must not be empty');
  }
  if (trimmed.length > MAX_LOUNGE_MESSAGE_LENGTH) {
    throw new LoungeValidationError(
      `Message content exceeds maximum length of ${MAX_LOUNGE_MESSAGE_LENGTH} characters`,
    );
  }
  return { content: trimmed };
}
