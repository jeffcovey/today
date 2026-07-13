import { jest } from '@jest/globals';

// These names must match what the AI SDK actually accepts. The SDK silently
// ignores unknown options, so a rename upstream fails without any error --
// the token cap is dropped and tool loops stop after a single step.
const generateText = jest.fn(async () => ({ text: 'ok', steps: [] }));
const streamText = jest.fn(() => ({ textStream: {}, fullStream: {} }));
const stepCountIs = jest.fn(n => ({ stepCount: n }));

jest.unstable_mockModule('ai', () => ({ generateText, streamText, stepCountIs, tool: jest.fn() }));

jest.unstable_mockModule('../src/config.js', () => ({
  getFullConfig: jest.fn(() => ({
    ai: { provider: 'openai', model: 'gpt-4o', openai: { api_key: 'test-key' } },
  })),
  getConfig: jest.fn(),
}));

jest.unstable_mockModule('@ai-sdk/openai', () => ({
  createOpenAI: jest.fn(() => modelName => ({ modelId: modelName })),
}));

const { createCompletion, streamCompletion, clearProviderCache } = await import('../src/ai-provider.js');

const messages = [{ role: 'user', content: 'hi' }];
const tools = { ping: { description: 'ping' } };

describe('AI Provider passes SDK-supported option names', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearProviderCache();
  });

  describe('createCompletion', () => {
    test('sends maxOutputTokens, not the legacy maxTokens', async () => {
      await createCompletion({ messages, maxTokens: 123 });

      const opts = generateText.mock.calls[0][0];
      expect(opts.maxOutputTokens).toBe(123);
      expect(opts).not.toHaveProperty('maxTokens');
    });

    test('defaults maxOutputTokens to 1000', async () => {
      await createCompletion({ messages });

      expect(generateText.mock.calls[0][0].maxOutputTokens).toBe(1000);
    });

    test('caps tool steps with stopWhen, not the legacy maxSteps', async () => {
      await createCompletion({ messages, tools, maxSteps: 3 });

      const opts = generateText.mock.calls[0][0];
      expect(stepCountIs).toHaveBeenCalledWith(3);
      expect(opts.stopWhen).toEqual({ stepCount: 3 });
      expect(opts).not.toHaveProperty('maxSteps');
    });

    test('defaults the tool step cap to 5', async () => {
      await createCompletion({ messages, tools });

      expect(stepCountIs).toHaveBeenCalledWith(5);
    });

    test('omits stopWhen when no tools are provided', async () => {
      await createCompletion({ messages });

      expect(generateText.mock.calls[0][0]).not.toHaveProperty('stopWhen');
      expect(stepCountIs).not.toHaveBeenCalled();
    });
  });

  describe('streamCompletion', () => {
    test('sends maxOutputTokens, not the legacy maxTokens', async () => {
      await streamCompletion({ messages, maxTokens: 456 });

      const opts = streamText.mock.calls[0][0];
      expect(opts.maxOutputTokens).toBe(456);
      expect(opts).not.toHaveProperty('maxTokens');
    });

    test('caps tool steps with stopWhen, not the legacy maxSteps', async () => {
      await streamCompletion({ messages, tools, maxSteps: 2 });

      const opts = streamText.mock.calls[0][0];
      expect(stepCountIs).toHaveBeenCalledWith(2);
      expect(opts.stopWhen).toEqual({ stepCount: 2 });
      expect(opts).not.toHaveProperty('maxSteps');
    });
  });
});
