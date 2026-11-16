import {
  createSearchWebTool,
  EMPTY_WEB_SEARCH_QUERY_RESULT,
  executeGoogleWebSearch,
  IGeminiWebSearchClient,
  PersonaToolRegistry,
  runStructuredDialogueWithTools,
  SEARCH_WEB_TOOL_DECLARATION,
  SEARCH_WEB_TOOL_NAME,
  ToolLogger,
} from '../src';

describe('shared webSearch, PersonaToolRegistry, and runStructuredDialogueWithTools', () => {
  describe('executeGoogleWebSearch', () => {
    it('handles uninitialized client, blank query, and empty model fail-fast', async () => {
      expect(await executeGoogleWebSearch(null, 'search-model', 'hello')).toBe(
        '検索クライアントが未初期化です。',
      );

      const client: IGeminiWebSearchClient = {
        models: { generateContent: jest.fn() },
      };
      expect(await executeGoogleWebSearch(client, 'search-model', '   ')).toBe(
        '検索クエリが空です。',
      );
      await expect(executeGoogleWebSearch(client, '   ', 'query')).rejects.toThrow(
        'Cannot execute Google Web Search: search model identifier must not be empty',
      );
    });

    it('invokes Gemini googleSearch grounding tool and handles empty or error responses gracefully', async () => {
      const logger: ToolLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
      const generateContent = jest
        .fn()
        .mockResolvedValueOnce({ text: '  Grounded Answer  ' })
        .mockResolvedValueOnce({ text: '   ' })
        .mockRejectedValueOnce(new Error('Network timeout'));

      const client: IGeminiWebSearchClient = { models: { generateContent } };

      const ok = await executeGoogleWebSearch(client, 'search-model', '  weather tokyo  ', logger);
      expect(ok).toBe('Grounded Answer');
      expect(generateContent).toHaveBeenCalledWith({
        model: 'search-model',
        contents: [{ role: 'user', parts: [{ text: 'weather tokyo' }] }],
        config: {
          tools: [{ googleSearch: {} }],
          safetySettings: [],
        },
      });

      expect(await executeGoogleWebSearch(client, 'search-model', 'empty', logger)).toBe(
        '該当する検索結果が見つかりませんでした。',
      );

      expect(await executeGoogleWebSearch(client, 'search-model', 'fail', logger)).toBe(
        '一時的なネットワークまたは検索エラーにより情報を取得できませんでした。',
      );
      expect(logger.warn).toHaveBeenCalledWith(
        '[executeWebSearch] Failed to search for query',
        expect.objectContaining({ query: 'fail', error: 'Network timeout' }),
      );
    });
  });

  describe('PersonaToolRegistry and createSearchWebTool', () => {
    it('rejects empty tool names, duplicate registrations, and unknown execution names', async () => {
      const registry = new PersonaToolRegistry();
      expect(registry.toToolGroups()).toEqual([]);

      expect(() =>
        registry.register({
          declaration: {
            ...SEARCH_WEB_TOOL_DECLARATION,
            name: '   ',
          },
          execute: async () => ({}),
        }),
      ).toThrow('Cannot register persona tool with empty name');

      const searchTool = createSearchWebTool(async (q) => `hit:${q}`);
      registry.register(searchTool);

      expect(registry.has(SEARCH_WEB_TOOL_NAME)).toBe(true);
      expect(registry.has('unknown_tool')).toBe(false);
      expect(registry.toToolGroups()).toEqual([{ functionDeclarations: [SEARCH_WEB_TOOL_DECLARATION] }]);

      expect(() => registry.register(searchTool)).toThrow('Persona tool "search_web" is already registered');
      await expect(registry.execute('missing', {})).rejects.toThrow('Unknown persona tool requested: "missing"');

      expect(await registry.execute(SEARCH_WEB_TOOL_NAME, { query: '  ai news  ' })).toEqual({
        result: 'hit:ai news',
      });
      expect(await registry.execute(SEARCH_WEB_TOOL_NAME, undefined)).toEqual({
        result: EMPTY_WEB_SEARCH_QUERY_RESULT,
      });
    });
  });

  describe('runStructuredDialogueWithTools', () => {
    it('formats Tatemae/Honne history, executes tool round, and validates structured JSON output', async () => {
      const registry = new PersonaToolRegistry().register(
        createSearchWebTool(async (q) => `searched:${q}`),
      );

      const generateStep = jest
        .fn()
        .mockResolvedValueOnce({
          functionCalls: [{ name: SEARCH_WEB_TOOL_NAME, args: { query: 'latest SDK' } }],
          modelContent: {
            role: 'model',
            parts: [{ functionCall: { name: SEARCH_WEB_TOOL_NAME, args: { query: 'latest SDK' } } }],
          },
        })
        .mockResolvedValueOnce({
          text: JSON.stringify({ thought: 'Looked it up cleanly', reply: 'Here is what I found!' }),
        });

      const res = await runStructuredDialogueWithTools({
        history: [
          { role: 'user', content: 'Hi', timestamp: '2026-05-01T00:00:00.000Z' },
          { role: 'model', content: 'Hello!', thought: 'Happy to see them' },
        ],
        userInput: 'Check the latest SDK',
        timezone: 'UTC',
        toolRegistry: registry,
        generateStep,
      });

      expect(res).toEqual({
        thought: 'Looked it up cleanly',
        reply: 'Here is what I found!',
      });
      expect(generateStep).toHaveBeenCalledTimes(2);
      const secondCallContents = generateStep.mock.calls[1][0];
      expect(secondCallContents[1].parts[0].text).toContain('【思考・本音】Happy to see them\n【発話】Hello!');
      expect(secondCallContents[secondCallContents.length - 1]).toEqual({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: SEARCH_WEB_TOOL_NAME,
              response: { result: 'searched:latest SDK' },
            },
          },
        ],
      });
    });

    it('falls back cleanly when maxToolRounds is 0 or when tool call name is unregistered, and validates empty outputs', async () => {
      const generateDirect = jest
        .fn()
        .mockResolvedValueOnce({
          text: JSON.stringify({ thought: 'direct', reply: 'Direct reply' }),
        })
        .mockResolvedValueOnce({ text: '' })
        .mockResolvedValueOnce({ text: JSON.stringify({ thought: 't', reply: '   ' }) });

      expect(
        await runStructuredDialogueWithTools({
          history: [],
          userInput: 'Ping',
          maxToolRounds: 0,
          generateStep: generateDirect,
        }),
      ).toEqual({ thought: 'direct', reply: 'Direct reply' });

      await expect(
        runStructuredDialogueWithTools({
          history: [],
          userInput: 'Ping',
          generateStep: generateDirect,
        }),
      ).rejects.toThrow('Gemini API returned empty structured response or content was filtered.');

      await expect(
        runStructuredDialogueWithTools({
          history: [],
          userInput: 'Ping',
          generateStep: generateDirect,
        }),
      ).rejects.toThrow('Gemini API returned structured response with empty reply.');

      const registry = new PersonaToolRegistry().register(
        createSearchWebTool(async () => 'result'),
      );
      const emptyAfterTool = jest
        .fn()
        .mockResolvedValueOnce({
          functionCalls: [{ name: SEARCH_WEB_TOOL_NAME, args: { query: 'q' } }],
        })
        .mockResolvedValueOnce({ text: '  ' });

      await expect(
        runStructuredDialogueWithTools({
          history: [],
          userInput: 'q',
          toolRegistry: registry,
          generateStep: emptyAfterTool,
        }),
      ).rejects.toThrow('Gemini API returned empty structured response after function execution.');
    });
  });
});
