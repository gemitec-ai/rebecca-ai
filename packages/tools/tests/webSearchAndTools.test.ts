import {
  createSearchWebTool,
  EMPTY_WEB_SEARCH_QUERY_RESULT,
  EmptyDialogueResponseError,
  IWebSearchProvider,
  PersonaToolRegistry,
  runToolDialogueLoop,
  SEARCH_WEB_TOOL_DECLARATION,
  SEARCH_WEB_TOOL_NAME,
  ToolDefinition,
} from '../src';

describe('@rebecca/tools contracts and dialogue orchestration', () => {
  describe('createSearchWebTool and SEARCH_WEB_TOOL_DECLARATION', () => {
    it('defines standard JSON Schema types without provider-specific enum casing', () => {
      expect(SEARCH_WEB_TOOL_DECLARATION).toEqual({
        name: SEARCH_WEB_TOOL_NAME,
        description: expect.any(String),
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: expect.any(String),
            },
          },
          required: ['query'],
        },
      });
    });

    it('invokes IWebSearchProvider objects or callback functions with trimmed queries and guards empty args', async () => {
      const provider: IWebSearchProvider = {
        search: jest.fn(async (q: string) => `provider:${q}`),
      };
      const objectTool = createSearchWebTool(provider);

      expect(await objectTool.execute({ query: '  type-safe sdk  ' })).toEqual({
        result: 'provider:type-safe sdk',
      });
      expect(provider.search).toHaveBeenCalledWith('type-safe sdk');

      expect(await objectTool.execute({ query: '   ' })).toEqual({
        result: EMPTY_WEB_SEARCH_QUERY_RESULT,
      });
      expect(await objectTool.execute(undefined)).toEqual({
        result: EMPTY_WEB_SEARCH_QUERY_RESULT,
      });

      const fnTool = createSearchWebTool(async (q) => `fn:${q}`);
      expect(await fnTool.execute({ query: 'hello' })).toEqual({ result: 'fn:hello' });
    });
  });

  describe('PersonaToolRegistry', () => {
    it('enforces unique non-empty names and dispatches registered executors', async () => {
      const registry = new PersonaToolRegistry();
      expect(registry.getDeclarations()).toEqual([]);

      expect(() =>
        registry.register({
          declaration: {
            ...SEARCH_WEB_TOOL_DECLARATION,
            name: '   ',
          },
          execute: async () => ({}),
        }),
      ).toThrow('Cannot register tool with an empty name');

      const searchTool = createSearchWebTool(async (q) => `hit:${q}`);
      registry.register(searchTool);

      expect(registry.has(SEARCH_WEB_TOOL_NAME)).toBe(true);
      expect(registry.has('unknown_tool')).toBe(false);
      expect(registry.has(undefined)).toBe(false);
      expect(registry.getDeclarations()).toEqual([SEARCH_WEB_TOOL_DECLARATION]);

      expect(() => registry.register(searchTool)).toThrow('Tool "search_web" is already registered');
      await expect(registry.execute('missing', {})).rejects.toThrow('Unknown tool requested: "missing"');
      expect(await registry.execute(SEARCH_WEB_TOOL_NAME, { query: 'test' })).toEqual({
        result: 'hit:test',
      });
    });
  });

  describe('runToolDialogueLoop', () => {
    it('dispatches multiple tool calls in a single round, records neutral round history, and parses output', async () => {
      const timeTool: ToolDefinition = {
        declaration: {
          name: 'get_time',
          description: 'Gets time',
          parameters: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        execute: async () => ({ now: '12:00' }),
      };

      const registry = new PersonaToolRegistry()
        .register(createSearchWebTool(async (q) => `searched:${q}`))
        .register(timeTool);

      const generateStep = jest
        .fn()
        .mockResolvedValueOnce({
          toolCalls: [
            { id: 'call-1', name: SEARCH_WEB_TOOL_NAME, args: { query: 'latest SDK' } },
            { id: 'call-2', name: 'get_time', args: {} },
          ],
          rawAssistantTurn: { opaque: 'model-turn' },
        })
        .mockResolvedValueOnce({
          text: ' {"reply":"Final Answer"} ',
        });

      const parseOutput = jest.fn((raw: string, afterTool: boolean) => ({
        parsed: JSON.parse(raw),
        afterTool,
      }));

      const result = await runToolDialogueLoop({
        initialTurns: [
          { role: 'user', text: 'Hi' },
          { role: 'model', text: 'Hello' },
        ],
        userInput: 'Check the latest SDK and time',
        toolRegistry: registry,
        generateStep,
        parseOutput,
      });

      expect(result).toEqual({
        parsed: { reply: 'Final Answer' },
        afterTool: true,
      });
      expect(parseOutput).toHaveBeenCalledWith('{"reply":"Final Answer"}', true);
      expect(generateStep).toHaveBeenCalledTimes(2);

      const firstCtx = generateStep.mock.calls[0][0];
      expect(firstCtx.declarations).toHaveLength(2);
      expect(firstCtx.rounds).toEqual([]);

      const secondCtx = generateStep.mock.calls[1][0];
      expect(secondCtx.declarations).toEqual([]);
      expect(secondCtx.rounds).toEqual([
        {
          rawAssistantTurn: { opaque: 'model-turn' },
          calls: [
            { id: 'call-1', name: SEARCH_WEB_TOOL_NAME, args: { query: 'latest SDK' } },
            { id: 'call-2', name: 'get_time', args: {} },
          ],
          outcomes: [
            { id: 'call-1', name: SEARCH_WEB_TOOL_NAME, result: { result: 'searched:latest SDK' } },
            { id: 'call-2', name: 'get_time', result: { now: '12:00' } },
          ],
        },
      ]);
    });

    it('handles zero rounds, unregistered tool calls, and throws EmptyDialogueResponseError cleanly', async () => {
      const registry = new PersonaToolRegistry().register(
        createSearchWebTool(async () => 'result'),
      );

      const directStep = jest
        .fn()
        .mockResolvedValueOnce({ text: 'Direct' })
        .mockResolvedValueOnce({ toolCalls: [{ name: 'unregistered' }], text: 'Fallback' })
        .mockResolvedValueOnce({ text: '   ' });

      expect(
        await runToolDialogueLoop({
          initialTurns: [],
          userInput: 'Ping',
          toolRegistry: registry,
          maxToolRounds: 0,
          generateStep: directStep,
          parseOutput: (raw, afterTool) => ({ raw, afterTool }),
        }),
      ).toEqual({ raw: 'Direct', afterTool: false });

      expect(
        await runToolDialogueLoop({
          initialTurns: [],
          userInput: 'Ping',
          toolRegistry: registry,
          generateStep: directStep,
          parseOutput: (raw, afterTool) => ({ raw, afterTool }),
        }),
      ).toEqual({ raw: 'Fallback', afterTool: false });

      await expect(
        runToolDialogueLoop({
          initialTurns: [],
          userInput: 'Ping',
          generateStep: directStep,
          parseOutput: (raw) => raw,
        }),
      ).rejects.toThrow(EmptyDialogueResponseError);

      const emptyDuringToolRound = jest
        .fn()
        .mockResolvedValueOnce({ text: '' })
        .mockResolvedValueOnce({ toolCalls: [{ name: SEARCH_WEB_TOOL_NAME, args: { query: 'q' } }] })
        .mockResolvedValueOnce({ text: '   ' });

      await expect(
        runToolDialogueLoop({
          initialTurns: [],
          userInput: 'Ping',
          toolRegistry: registry,
          generateStep: emptyDuringToolRound,
          parseOutput: (raw) => raw,
        }),
      ).rejects.toMatchObject({ afterToolExecution: false });

      await expect(
        runToolDialogueLoop({
          initialTurns: [],
          userInput: 'Ping',
          toolRegistry: registry,
          generateStep: emptyDuringToolRound,
          parseOutput: (raw) => raw,
        }),
      ).rejects.toMatchObject({ afterToolExecution: true });
    });
  });
});
