import type { ToolDeclaration } from '@rebecca/tools';
import { CopilotAttachment, UserDetail } from '@rebecca/types';
import { CopilotTool, CopilotToolContext, CopilotToolExecutionResult, resolveBoundedLimit } from '../types';

const ALLOWED_TOOL_USER_SORT_FIELDS: ReadonlySet<string> = new Set([
  'interactions',
  'followersCount',
  'createdAt',
]);

/**
 * Tool for querying user profiles by handle, interaction rank, or moderation status.
 */
export class SearchUsersTool implements CopilotTool {
  readonly name = 'search_users';
  readonly description = 'Searches user profiles by handle/name prefix, account status (ACTIVE, BLOCKED, MUTED), and interaction rankings.';

  readonly declaration: ToolDeclaration = {
    name: this.name,
    description: this.description,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Username or handle prefix to search for.'
        },
        status: {
          type: 'string',
          description: 'Account status filter: ACTIVE, BLOCKED, MUTED, or ALL.',
          enum: ['ACTIVE', 'BLOCKED', 'MUTED', 'ALL']
        },
        sortBy: {
          type: 'string',
          description: 'Field to sort users by: interactions, followersCount, or createdAt.',
          enum: ['interactions', 'followersCount', 'createdAt']
        },
        limit: {
          type: 'integer',
          description: 'Number of users to return (1 to 20, default is 5).'
        }
      },
      required: []
    }
  };

  async execute(params: Record<string, unknown>, context: CopilotToolContext): Promise<CopilotToolExecutionResult> {
    if (!context.usersRepo) {
      return { data: { error: 'UsersRepository is not configured' } };
    }

    const limit = resolveBoundedLimit(params.limit, 20);
    const cleanQuery = typeof params.query === 'string' ? params.query.replace(/^@/, '').trim() : '';

    const sortBy =
      typeof params.sortBy === 'string' && ALLOWED_TOOL_USER_SORT_FIELDS.has(params.sortBy)
        ? params.sortBy
        : 'interactions';

    const result = await context.usersRepo.getAll({
      search: cleanQuery.length > 0 ? cleanQuery : undefined,
      limit,
      sortBy,
      sortOrder: 'desc'
    });

    let users = result.data ?? [];
    if (typeof params.status === 'string' && params.status !== 'ALL') {
      const targetStatus = params.status;
      users = users.filter((u: UserDetail) => u.status === targetStatus);
    }

    // Omit orphan user documents lacking both username and display name.
    const validUsers = users.filter((u: UserDetail) => Boolean(u.username || u.name));

    let candidateUsers = validUsers;
    if (cleanQuery.length > 0) {
      const exactMatch = validUsers.find(
        u => u.username?.toLowerCase() === cleanQuery.toLowerCase() ||
             u.id?.toLowerCase() === cleanQuery.toLowerCase() ||
             u.name?.toLowerCase() === cleanQuery.toLowerCase()
      );
      if (exactMatch) {
        candidateUsers = [exactMatch];
      }
    }

    const attachments: CopilotAttachment[] = candidateUsers.map((u: UserDetail) => ({
      type: 'user',
      id: u.id,
      title: u.name && u.name.length > 0
        ? (u.username ? `${u.name} (@${u.username})` : u.name)
        : (u.username ? `@${u.username}` : `User ${u.id}`),
      subtitle: u.username ? `@${u.username}` : u.id,
      statusBadge: u.status,
      metrics: {
        interactions: u.interactions
      },
      navigationPath: `/users?userId=${u.id}`
    }));

    const summary = candidateUsers.map((u: UserDetail) => ({
      id: u.id,
      username: u.username,
      name: u.name,
      status: u.status,
      interactions: u.interactions,
      lastSeen: u.lastSeen
    }));

    return {
      data: {
        totalFound: users.length,
        users: summary
      },
      attachments
    };
  }
}
