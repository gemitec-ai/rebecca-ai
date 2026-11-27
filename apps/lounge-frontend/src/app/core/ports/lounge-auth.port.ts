import type {
  LoungeAuthSessionDto,
  LoungeLoginRequestDto,
  LoungeSignUpRequestDto,
} from '@rebecca/types';

/**
 * Hexagonal port abstracting X-linked Private Lounge authentication and disclaimer sign-up.
 */
export abstract class LoungeAuthPort {
  /** Restores the active authenticated Private Lounge session if present. */
  public abstract getCurrentSession(): Promise<LoungeAuthSessionDto | null>;
  /** Signs in an existing Private Lounge user linked via X OAuth. */
  public abstract loginWithX(request: LoungeLoginRequestDto): Promise<LoungeAuthSessionDto>;
  /** Registers a new X-linked user after scroll-verified legal disclaimer acceptance. */
  public abstract signUpWithX(request: LoungeSignUpRequestDto): Promise<LoungeAuthSessionDto>;
  /** Terminates the active Private Lounge session. */
  public abstract logout(): Promise<void>;
}
