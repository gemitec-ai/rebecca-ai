import type { ToolDeclaration } from '@rebecca/tools';
import { CopilotTool, CopilotToolContext, CopilotToolExecutionResult } from '../types';

const ALLOWED_KPI_PERIODS: ReadonlySet<string> = new Set(['weekly', 'monthly', 'yearly']);

/**
 * Tool for retrieving high-level KPI metrics and system growth trends.
 */
export class GetKpiSummaryTool implements CopilotTool {
  readonly name = 'get_kpi_summary';
  readonly description = 'Retrieves high-level system KPI metrics (follower growth, engagement rate, DAU, API calls) and trends.';

  readonly declaration: ToolDeclaration = {
    name: this.name,
    description: this.description,
    parameters: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          description: 'Time period for the KPI summary: weekly, monthly, or yearly. Default is monthly.',
          enum: ['weekly', 'monthly', 'yearly']
        }
      },
      required: []
    }
  };

  async execute(params: Record<string, unknown>, context: CopilotToolContext): Promise<CopilotToolExecutionResult> {
    if (!context.timelineRepo) {
      return { data: { error: 'TimelineRepository is not configured' } };
    }

    const rawPeriod = typeof params.period === 'string' ? params.period.trim().toLowerCase() : '';
    const period = ALLOWED_KPI_PERIODS.has(rawPeriod) ? rawPeriod : 'monthly';
    const metrics = await context.timelineRepo.getMetrics(period);

    return {
      data: {
        period,
        followers: metrics.followers,
        followersTrendPercent: metrics.followersTrend,
        engagementRatePercent: metrics.engagementRate,
        engagementTrendPercent: metrics.engagementTrend,
        dailyActiveUsers: metrics.dailyActiveUsers,
        dauTrendPercent: metrics.dauTrend,
        apiCallsTotal: metrics.apiCalls,
        apiCallsTrendPercent: metrics.apiCallsTrend
      }
    };
  }
}
