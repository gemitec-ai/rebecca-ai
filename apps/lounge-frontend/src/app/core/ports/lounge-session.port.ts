import type {
  LoungeCreateSessionRequestDto,
  LoungeMessageListResponseDto,
  LoungeSendMessageRequestDto,
  LoungeSendMessageResponseDto,
  LoungeSession,
  LoungeSessionListResponseDto,
} from '@rebecca/types';

/**
 * Hexagonal port abstracting Private Lounge chat sessions and turn transmission.
 */
export abstract class LoungeSessionPort {
  /** Retrieves paginated Private Lounge conversation sessions for the signed-in user. */
  public abstract listSessions(
    limit?: number,
    startAfterId?: string,
  ): Promise<LoungeSessionListResponseDto>;
  /** Creates a new isolated Private Lounge conversation thread. */
  public abstract createSession(request: LoungeCreateSessionRequestDto): Promise<LoungeSession>;
  /** Retrieves paginated chat turns belonging to `sessionId`. */
  public abstract listMessages(
    sessionId: string,
    limit?: number,
    startAfterId?: string,
  ): Promise<LoungeMessageListResponseDto>;
  /** Sends a user message and returns the assistant reply with updated turn quota. */
  public abstract sendMessage(
    sessionId: string,
    request: LoungeSendMessageRequestDto,
  ): Promise<LoungeSendMessageResponseDto>;
}
