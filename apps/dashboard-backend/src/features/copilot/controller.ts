import { Request, Response } from 'express';
import { isValidTimezone } from '../../config';
import { CopilotUseCase } from './usecase';
import { handleControllerError } from '../../utils/httpError';

/**
 * Controller for handling Copilot-related requests.
 */
export class CopilotController {
  /**
   * Creates an instance of CopilotController.
   * 
   * @param useCase - The copilot use case instance.
   */
  constructor(private useCase: CopilotUseCase) {}

  /**
   * Handles Copilot chat interactions.
   * 
   * @param req - The Express Request object containing message and context.
   * @param res - The Express Response object.
   * @returns A promise that resolves when the response is sent.
   */
  async chat(req: Request, res: Response): Promise<void> {
    const { message, currentContext, history, language, timezone } = req.body;
    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'Message is required' });
      return;
    }

    let validatedTimezone: string | undefined;
    if (timezone !== undefined) {
      if (typeof timezone !== 'string' || !isValidTimezone(timezone)) {
        res.status(400).json({ error: 'Invalid timezone: must be a valid IANA time zone identifier' });
        return;
      }
      validatedTimezone = timezone.trim();
    }

    const boundedMessage = message.slice(0, 2000);
    const boundedHistory = Array.isArray(history)
      ? history.slice(-20).map((item: { role?: string; text?: string }) => ({
          role: item?.role === 'model' ? ('model' as const) : ('user' as const),
          text: typeof item?.text === 'string' ? item.text.slice(0, 2000) : '',
        }))
      : history;

    try {
      const response = await this.useCase.processChat({
        message: boundedMessage,
        currentContext,
        history: boundedHistory,
        ...(language !== undefined ? { language } : {}),
        ...(validatedTimezone !== undefined ? { timezone: validatedTimezone } : {}),
      });
      res.json(response);
    } catch (err) {
      handleControllerError(res, err, 'Failed to process chat');
    }
  }
}
