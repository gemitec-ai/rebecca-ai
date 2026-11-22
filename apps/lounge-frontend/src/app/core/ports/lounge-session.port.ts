import type {
  LoungeMessageListResponseDto,
  LoungeSendMessageRequestDto,
  LoungeSendMessageResponseDto,
  LoungeSession,
} from '@rebecca/types';

/**
 * Hexagonal port abstracting the user's single persistent Private Lounge chat session and turn transmission.
 */
export abstract class LoungeSessionPort {
  /** Retrieves (or initializes) the signed-in user's single continuous Private Lounge conversation session. */
  public abstract getSession(): Promise<LoungeSession>;

  /** Retrieves paginated chat turns for the user's single session. */
  public abstract listMessages(
    limit?: number,
    startAfterId?: string,
  ): Promise<LoungeMessageListResponseDto>;

  /** Sends a user message and returns the assistant reply with updated turn quota and optional matched illustration. */
  public abstract sendMessage(
    request: LoungeSendMessageRequestDto,
  ): Promise<LoungeSendMessageResponseDto>;
}
