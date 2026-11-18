import { Request, Response } from 'express';
import { isValidTimezone } from '../../config';
import { CopilotUseCase } from './usecase';
import { getTraceHeader, handleControllerError } from '../../utils/httpError';

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
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      res.status(400).json({ error: 'Invalid request body: expected JSON object' });
      return;
    }

    const { message, currentContext, history, language, timezone } = req.body;
    if (typeof message !== 'string' || message.trim().length === 0) {
      res.status(400).json({ error: 'Message is required' });
      return;
    }

    if (currentContext !== undefined && typeof currentContext !== 'string') {
      res.status(400).json({ error: 'Invalid currentContext: must be a string' });
      return;
    }

    if (history !== undefined && !Array.isArray(history)) {
      res.status(400).json({ error: 'Invalid history: must be an array' });
      return;
    }

    if (language !== undefined && language !== 'ja' && language !== 'en') {
      res.status(400).json({ error: 'Invalid language: must be "ja" or "en"' });
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

    const traceHeader = getTraceHeader(req);
    const boundedMessage = message.trim().slice(0, 2000);
    const sanitizeContext = (raw: string): string =>
      raw
        .replace(/\p{Cc}+/gu, ' ')
        .replace(/\[/g, '(')
        .replace(/\]/g, ')')
        .replace(/【/g, '《')
        .replace(/】/g, '》')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .slice(0, 500);
    const sanitizedContext =
      typeof currentContext === 'string' ? sanitizeContext(currentContext) : '';
    const boundedContext = sanitizedContext.length > 0 ? sanitizedContext : undefined;
    const boundedHistory = Array.isArray(history)
      ? history.slice(-20).map((item: { role?: string; text?: string; thought?: string; time?: string }) => {
          const rawTime = typeof item?.time === 'string' ? item.time.trim() : '';
          const validTime =
            rawTime.length > 0 && rawTime.length <= 64 && !Number.isNaN(Date.parse(rawTime))
              ? rawTime
              : undefined;
          return {
            role: item?.role === 'model' ? ('model' as const) : ('user' as const),
            text: typeof item?.text === 'string' ? item.text.trim().slice(0, 2000) : '',
            ...(typeof item?.thought === 'string' && item.thought.trim().length > 0
              ? { thought: item.thought.trim().slice(0, 500) }
              : {}),
            ...(validTime !== undefined ? { time: validTime } : {}),
          };
        })
      : undefined;

    try {
      const response = await this.useCase.processChat({
        message: boundedMessage,
        ...(boundedContext !== undefined ? { currentContext: boundedContext } : {}),
        ...(boundedHistory !== undefined ? { history: boundedHistory } : {}),
        ...(language !== undefined ? { language } : {}),
        ...(validatedTimezone !== undefined ? { timezone: validatedTimezone } : {}),
      });
      res.json(response);
    } catch (err) {
      handleControllerError(res, err, 'Failed to process chat', undefined, traceHeader);
    }
  }
}
