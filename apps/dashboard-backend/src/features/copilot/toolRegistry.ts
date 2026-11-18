import { PersonaToolRegistry, type ToolDeclaration } from '@rebecca/tools';
import { CopilotTool, CopilotToolContext, CopilotToolExecutionResult } from './types';
import { SearchTimelinePostsTool } from './tools/postsTool';
import { SearchUsersTool } from './tools/usersTool';
import { SearchAssetsTool } from './tools/assetsTool';
import { GetKpiSummaryTool } from './tools/kpiTool';
import { SearchSupportersTool } from './tools/supportersTool';
import { GetFeatureGuideTool } from './tools/featureGuideTool';
import { ProposeDestructiveActionTool } from './tools/actionTool';
import { logger } from '../../utils/logger';

/**
 * Registry managing available copilot tools and dispatching function calls.
 */
export class CopilotToolRegistry {
  private readonly tools = new Map<string, CopilotTool>();

  constructor() {
    this.register(new SearchTimelinePostsTool());
    this.register(new SearchUsersTool());
    this.register(new SearchAssetsTool());
    this.register(new GetKpiSummaryTool());
    this.register(new SearchSupportersTool());
    this.register(new GetFeatureGuideTool());
    this.register(new ProposeDestructiveActionTool());
  }

  /**
   * Registers a tool instance.
   */
  register(tool: CopilotTool): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Retrieves all provider-neutral JSON Schema tool declarations.
   */
  getFunctionDeclarations(): ToolDeclaration[] {
    return Array.from(this.tools.values()).map((t) => t.declaration);
  }

  /**
   * Builds a `@rebecca/tools` {@link PersonaToolRegistry} bound to the request context
   * and side-effect collector for rich attachments and HITL confirmation proposals.
   */
  toPersonaToolRegistry(
    context: CopilotToolContext,
    onToolResult: (result: CopilotToolExecutionResult) => void,
  ): PersonaToolRegistry {
    const registry = new PersonaToolRegistry();
    for (const tool of this.tools.values()) {
      registry.register({
        declaration: tool.declaration,
        execute: async (args) => {
          const toolResult = await this.execute(tool.name, args ?? {}, context);
          onToolResult(toolResult);
          const rawData = toolResult.data;
          if (rawData && typeof rawData === 'object' && !Array.isArray(rawData)) {
            return rawData as Record<string, unknown>;
          }
          return { result: rawData };
        },
      });
    }
    return registry;
  }

  /**
   * Dispatches and executes a tool by name with safety boundary.
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    context: CopilotToolContext,
  ): Promise<CopilotToolExecutionResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      logger.warn(`Attempted execution of unknown tool: ${name}`);
      return {
        data: { error: `Tool ${name} is not registered` },
      };
    }

    try {
      return await tool.execute(args, context);
    } catch (err) {
      logger.error(`Error executing copilot tool ${name}`, err);
      return {
        data: { error: `Failed to execute ${name}: ${err instanceof Error ? err.message : String(err)}` },
      };
    }
  }
}
