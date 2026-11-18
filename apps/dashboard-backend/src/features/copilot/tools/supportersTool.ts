import type { ToolDeclaration } from '@rebecca/tools';
import { SupportTransactionDoc } from '@rebecca/types';
import { CopilotTool, CopilotToolContext, CopilotToolExecutionResult, resolveBoundedLimit } from '../types';

/**
 * Tool for inspecting supporter transactions and fan club metrics.
 */
export class SearchSupportersTool implements CopilotTool {
  readonly name = 'search_supporters';
  readonly description = 'Retrieves supporter ledger metrics, transaction counts, and digital reward catalog status.';

  readonly declaration: ToolDeclaration = {
    name: this.name,
    description: this.description,
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'Number of recent supporter records to inspect (1 to 20, default is 5).'
        }
      },
      required: []
    }
  };

  async execute(params: Record<string, unknown>, context: CopilotToolContext): Promise<CopilotToolExecutionResult> {
    if (!context.supportersRepo) {
      return { data: { error: 'SupportersRepository is not configured' } };
    }

    const limit = resolveBoundedLimit(params.limit, 20);
    const ledger = await context.supportersRepo.getTransactions({ limit });

    return {
      data: {
        summary: ledger.summary,
        recentCount: ledger.transactions.length,
        recentSupporters: ledger.transactions.map((item: SupportTransactionDoc) => ({
          id: item.id,
          supporterName: item.safeName || item.rawName,
          amount: item.amount,
          currency: item.currency,
          status: item.status,
          date: item.createdAt
        }))
      }
    };
  }
}
