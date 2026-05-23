import express from 'express';
import { createAiCommitMessageHandler } from '../src/git-ai-commit-message-route.js';

function parseSseEvents(raw) {
  return raw
    .split('\n\n')
    .map((eventText) => eventText.trim())
    .filter(Boolean)
    .map((eventText) => eventText.split('\n'))
    .flatMap((lines) => lines.filter((line) => line.startsWith('data:')))
    .map((line) => {
      const payload = line.startsWith('data: ') ? line.slice(6) : line.slice(5);
      return JSON.parse(payload);
    });
}

async function withServer(handler, run) {
  const app = express();
  app.post('/_git/ai-commit-message', handler);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/_git/ai-commit-message`;

  try {
    return await run(url);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('POST /_git/ai-commit-message SSE protocol', () => {
  test('streams text chunks and terminal done event', async () => {
    const handler = createAiCommitMessageHandler({
      gitExecFn: () => 'diff --git a/file b/file\n+new line',
      isAIAvailableFn: async () => true,
      getProviderNameFn: () => 'openai',
      streamCompletionFn: async () => ({
        textStream: (async function* () {
          yield 'feat: ';
          yield 'stream test message';
        })(),
      }),
    });

    await withServer(handler, async (url) => {
      const response = await fetch(url, { method: 'POST' });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      const body = await response.text();
      const events = parseSseEvents(body);

      const textEvents = events.filter((event) => event.type === 'text');
      expect(textEvents.length).toBeGreaterThanOrEqual(2);
      const streamedMessage = textEvents.map((event) => event.content).join('');
      expect(streamedMessage).toBe('feat: stream test message');

      const doneEvent = events.find((event) => event.type === 'done');
      expect(doneEvent).toBeDefined();
      expect(doneEvent.message).toBe(streamedMessage);
    });
  });

  test('emits SSE error event on stream failure after headers are sent', async () => {
    const handler = createAiCommitMessageHandler({
      gitExecFn: () => 'diff --git a/file b/file\n+new line',
      isAIAvailableFn: async () => true,
      getProviderNameFn: () => 'openai',
      streamCompletionFn: async () => {
        throw new Error('Simulated stream failure');
      },
    });

    await withServer(handler, async (url) => {
      const response = await fetch(url, { method: 'POST' });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      const body = await response.text();
      const events = parseSseEvents(body);

      const errorEvent = events.find((event) => event.type === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent.message).toContain('Failed to generate commit message');
    });
  });
});
