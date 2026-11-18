import {
  createSearchWebTool,
  DEFAULT_EMPTY_WEB_SEARCH_QUERY_RESULT,
  EmptyDialogueResponseError,
  ILLMToolDialogueClient,
  IWebSearchProvider,
  PersonaToolRegistry,
  runToolDialogueLoop,
  SEARCH_WEB_TOOL_DECLARATION,
  SEARCH_WEB_TOOL_NAME,
  ToolDefinition,
} from '../src';

describe('@rebecca/tools multi-provider contracts and dialogue orchestration', () => {
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

    it('invokes IWebSearchProvider or callbacks and supports custom empty-query fallback text', async () => {
      const provider: IWebSearchProvider = {
        search: jest.fn(async (q: string) => `provider:${q}`),
      };
      const objectTool = createSearchWebTool(provider);

      expect(await objectTool.execute({ query: '  type-safe sdk  ' })).toEqual({
        result: 'provider:type-safe sdk',
      });
      expect(provider.search).toHaveBeenCalledWith('type-safe sdk');

      expect(await objectTool.execute({ query: '   ' })).toEqual({
        result: DEFAULT_EMPTY_WEB_SEARCH_QUERY_RESULT,
      });
      expect(await objectTool.execute(undefined)).toEqual({
        result: DEFAULT_EMPTY_WEB_SEARCH_QUERY_RESULT,
      });

      const customFallbackTool = createSearchWebTool(async (q) => `fn:${q}`, {
        emptyQueryResult: 'Search query was empty.',
      });
      expect(await customFallbackTool.execute({ query: '' })).toEqual({
        result: 'Search query was empty.',
      });
      expect(await customFallbackTool.execute({ query: 'hello' })).toEqual({ result: 'fn:hello' });
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
    it('dispatches multiple tool calls through ILLMToolDialogueClient using neutral assistant role and call IDs', async () => {
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

      const client: ILLMToolDialogueClient = {
        generateStep: jest
          .fn()
          .mockResolvedValueOnce({
            toolCalls: [
              { id: 'call_azure_1', name: SEARCH_WEB_TOOL_NAME, args: { query: 'latest SDK' } },
              { id: 'call_azure_2', name: 'get_time', args: {} },
            ],
            opaqueProviderTurn: { role: 'assistant', tool_calls: [{ id: 'call_azure_1' }] },
          })
          .mockResolvedValueOnce({
            text: ' {"reply":"Final Answer"} ',
          }),
      };

      const parseOutput = jest.fn((raw: string, afterTool: boolean) => ({
        parsed: JSON.parse(raw),
        afterTool,
      }));

      const result = await runToolDialogueLoop({
        initialTurns: [
          { role: 'user', text: 'Hi' },
          { role: 'assistant', text: 'Hello' },
        ],
        userInput: 'Check the latest SDK and time',
        toolRegistry: registry,
        client,
        parseOutput,
      });

      expect(result).toEqual({
        parsed: { reply: 'Final Answer' },
        afterTool: true,
      });
      expect(parseOutput).toHaveBeenCalledWith('{"reply":"Final Answer"}', true);
      expect(client.generateStep).toHaveBeenCalledTimes(2);

      const secondCtx = (client.generateStep as jest.Mock).mock.calls[1][0];
      expect(secondCtx.declarations).toEqual([]);
      expect(secondCtx.rounds).toEqual([
        {
          opaqueProviderTurn: { role: 'assistant', tool_calls: [{ id: 'call_azure_1' }] },
          calls: [
            { id: 'call_azure_1', name: SEARCH_WEB_TOOL_NAME, args: { query: 'latest SDK' } },
            { id: 'call_azure_2', name: 'get_time', args: {} },
          ],
          outcomes: [
            { id: 'call_azure_1', name: SEARCH_WEB_TOOL_NAME, result: { result: 'searched:latest SDK' } },
            { id: 'call_azure_2', name: 'get_time', result: { now: '12:00' } },
          ],
        },
      ]);
    });

    it('handles callback steps, zero rounds, unregistered tool calls, and EmptyDialogueResponseError', async () => {
      const registry = new PersonaToolRegistry().register(
        createSearchWebTool(async () => 'result'),
      );

      const directStep = jest
        .fn()
        .mockResolvedValueOnce({ toolCalls: [{ name: 'unregistered' }], text: 'Fallback' })
        .mockResolvedValueOnce({ text: '   ' });

      const zeroRoundClient = jest.fn().mockResolvedValue({ text: 'Direct' });
      for (const nonPositiveRounds of [0, 0.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(
          await runToolDialogueLoop({
            initialTurns: [],
            userInput: 'Ping',
            toolRegistry: registry,
            maxToolRounds: nonPositiveRounds,
            client: zeroRoundClient,
            parseOutput: (raw, afterTool) => ({ raw, afterTool }),
          }),
        ).toEqual({ raw: 'Direct', afterTool: false });
      }
      expect(zeroRoundClient).toHaveBeenCalledTimes(5);

      expect(
        await runToolDialogueLoop({
          initialTurns: [],
          userInput: 'Ping',
          toolRegistry: registry,
          client: directStep,
          parseOutput: (raw, afterTool) => ({ raw, afterTool }),
        }),
      ).toEqual({ raw: 'Fallback', afterTool: false });

      await expect(
        runToolDialogueLoop({
          initialTurns: [],
          userInput: 'Ping',
          client: directStep,
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
          client: emptyDuringToolRound,
          parseOutput: (raw) => raw,
        }),
      ).rejects.toMatchObject({ afterToolExecution: false });

      await expect(
        runToolDialogueLoop({
          initialTurns: [],
          userInput: 'Ping',
          toolRegistry: registry,
          client: emptyDuringToolRound,
          parseOutput: (raw) => raw,
        }),
      ).rejects.toMatchObject({ afterToolExecution: true });
    });

    it('supports pure tryAcceptStepOutput fast path vs formal finalStep synthesis preserving tool rounds', async () => {
      const registry = new PersonaToolRegistry().register(
        createSearchWebTool(async (q) => `found:${q}`),
      );

      const fastClient = jest.fn().mockResolvedValueOnce({
        text: '{"thought":"t","reply":"direct"}',
      });
      const tryAccept = (raw: string) => {
        try {
          const obj = JSON.parse(raw) as { thought?: string; reply?: string };
          return obj.thought && obj.reply ? { thought: obj.thought, reply: obj.reply } : undefined;
        } catch {
          return undefined;
        }
      };

      const fastRes = await runToolDialogueLoop({
        initialTurns: [],
        userInput: 'Hi',
        toolRegistry: registry,
        maxToolRounds: 2,
        client: fastClient,
        tryAcceptStepOutput: tryAccept,
        parseOutput: () => ({ thought: 'never', reply: 'never' }),
      });
      expect(fastRes).toEqual({ thought: 't', reply: 'direct' });
      expect(fastClient).toHaveBeenCalledTimes(1);

      const fallbackClient = jest
        .fn()
        .mockResolvedValueOnce({
          opaqueProviderTurn: { role: 'model', parts: [{ functionCall: { name: SEARCH_WEB_TOOL_NAME } }] },
          toolCalls: [{ id: 'c1', name: SEARCH_WEB_TOOL_NAME, args: { query: 'weather' } }],
        })
        .mockResolvedValueOnce({
          text: 'Plain prose without JSON schema',
        })
        .mockResolvedValueOnce({
          text: '{"thought":"rainy","reply":"Carry an umbrella!"}',
        });

      const parseOutput = jest.fn((raw: string, afterToolExecution: boolean) => ({
        ...(JSON.parse(raw) as { thought: string; reply: string }),
        afterToolExecution,
      }));

      const synthesizedRes = await runToolDialogueLoop({
        initialTurns: [],
        userInput: 'Weather?',
        toolRegistry: registry,
        maxToolRounds: 2,
        client: fallbackClient,
        tryAcceptStepOutput: tryAccept,
        parseOutput,
      });

      expect(synthesizedRes).toEqual({
        thought: 'rainy',
        reply: 'Carry an umbrella!',
        afterToolExecution: true,
      });
      expect(fallbackClient).toHaveBeenCalledTimes(3);
      expect(fallbackClient.mock.calls[2][0].declarations).toEqual([]);
      expect(fallbackClient.mock.calls[2][0].rounds).toHaveLength(1);
    });
  });
});
