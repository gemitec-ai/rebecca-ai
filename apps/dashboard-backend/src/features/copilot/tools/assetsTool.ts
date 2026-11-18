import { GoogleGenAI } from '@google/genai';
import type { ToolDeclaration } from '@rebecca/tools';
import { Asset, CopilotAttachment } from '@rebecca/types';
import { CopilotTool, CopilotToolContext, CopilotToolExecutionResult, resolveBoundedLimit } from '../types';
import { createCopilotEmbeddingProvider } from '../embeddingAdapter';
import { logger } from '../../../utils/logger';
import { config } from '../../../config';

const ALLOWED_TOOL_ASSET_STATUSES: ReadonlySet<string> = new Set([
  'PENDING',
  'PROCESSING',
  'SUCCESS',
  'FAILED',
]);

/**
 * Tool for semantic vector search and status filtering of media image assets.
 */
export class SearchAssetsTool implements CopilotTool {
  readonly name = 'search_assets';
  readonly description = 'Searches image assets using natural language semantic vector search against caption embeddings, or filters assets by processing status (e.g. FAILED).';

  readonly declaration: ToolDeclaration = {
    name: this.name,
    description: this.description,
    parameters: {
      type: 'object',
      properties: {
        semanticQuery: {
          type: 'string',
          description: 'Natural language description of the visual scene to find (e.g., "cyberpunk neon street", "eating sweets", "relaxing at a cafe").'
        },
        status: {
          type: 'string',
          description: 'Filter by asset processing status: PENDING, PROCESSING, SUCCESS, FAILED, or ALL.',
          enum: ['PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'ALL']
        },
        limit: {
          type: 'integer',
          description: 'Number of assets to return (1 to 10, default is 5).'
        }
      },
      required: []
    }
  };

  async execute(params: Record<string, unknown>, context: CopilotToolContext): Promise<CopilotToolExecutionResult> {
    if (!context.assetsRepo) {
      return { data: { error: 'AssetsRepository is not configured' } };
    }

    const limit = resolveBoundedLimit(params.limit, 10);
    const semanticQuery = typeof params.semanticQuery === 'string' ? params.semanticQuery.trim() : '';
    let matchedAssets: Asset[] = [];

    const embedder =
      context.embedder ??
      (config.gemini.apiKey
        ? createCopilotEmbeddingProvider(new GoogleGenAI({ apiKey: config.gemini.apiKey }))
        : undefined);

    if (semanticQuery.length > 0 && embedder) {
      try {
        const vector = await embedder.generateEmbedding(semanticQuery);
        if (vector.length > 0) {
          matchedAssets = await context.assetsRepo.findByVector(vector, limit);
        }
      } catch (err) {
        logger.warn('Failed vector embedding calculation for asset search, falling back to text search', {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    const statusFilter =
      typeof params.status === 'string' && ALLOWED_TOOL_ASSET_STATUSES.has(params.status)
        ? params.status
        : undefined;

    if (matchedAssets.length === 0) {
      const paginated = await context.assetsRepo.getPaginated({
        search: semanticQuery.length > 0 ? semanticQuery : undefined,
        status: statusFilter,
        limit,
        page: 1
      });
      matchedAssets = paginated.data ?? [];
    } else if (statusFilter) {
      matchedAssets = matchedAssets.filter((a: Asset) => a.status === statusFilter);
    }

    const finalAssets = matchedAssets.slice(0, limit);

    const attachments: CopilotAttachment[] = finalAssets.map((a: Asset) => ({
      type: 'image',
      id: a.id,
      title: a.filename || a.id,
      subtitle: a.caption || (a.status === 'FAILED' ? 'Caption generation failed' : ''),
      imageUrl: a.url,
      thumbnailUrl: a.thumbnailUrl ?? a.url,
      statusBadge: a.status,
      navigationPath: `/assets?assetId=${a.id}`
    }));

    const summary = finalAssets.map((a: Asset) => ({
      id: a.id,
      filename: a.filename,
      caption: a.caption,
      status: a.status,
      thumbnailUrl: a.thumbnailUrl ?? a.url
    }));

    return {
      data: {
        totalFound: finalAssets.length,
        assets: summary
      },
      attachments
    };
  }
}
