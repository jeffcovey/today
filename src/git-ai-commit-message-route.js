import { streamCompletion, isAIAvailable, getProviderName } from './ai-provider.js';

export function createAiCommitMessageHandler({
  gitExecFn,
  streamCompletionFn = streamCompletion,
  isAIAvailableFn = isAIAvailable,
  getProviderNameFn = getProviderName,
} = {}) {
  if (typeof gitExecFn !== 'function') {
    throw new TypeError('gitExecFn is required');
  }

  return async function aiCommitMessageHandler(req, res) {
    let isAborted = false;
    try {
      const available = await isAIAvailableFn();
      if (!available) {
        return res.status(400).json({ error: 'No AI provider configured. Check your config.toml [ai] section.' });
      }

      let diff = '';
      try {
        diff = gitExecFn(['diff', '--cached']);
      } catch {
        diff = '';
      }

      if (!diff.trim()) {
        return res.status(400).json({ error: 'No staged changes to generate a message for.' });
      }

      // Truncate very large diffs to avoid exceeding context limits.
      // Use a lower cap for local Ollama to reduce prefill latency.
      const provider = getProviderNameFn();
      const maxDiffLength = provider === 'ollama' ? 5000 : 15000;
      if (diff.length > maxDiffLength) {
        diff = diff.slice(0, maxDiffLength) + '\n\n[... diff truncated ...]';
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const streamAbortController = new AbortController();
      req.on('close', () => {
        isAborted = true;
        if (!streamAbortController.signal.aborted) {
          streamAbortController.abort();
        }
      });

      const streamResult = await streamCompletionFn({
        system: 'You are a helpful assistant that writes concise git commit messages. Write a single conventional commit message (type: description) for the given diff. Use lowercase type. Keep the description under 72 characters. Do not include a body or footer. Output only the commit message, nothing else.',
        messages: [{ role: 'user', content: diff }],
        maxTokens: 100,
        temperature: 0,
        abortSignal: streamAbortController.signal,
      });

      let fullMessage = '';
      for await (const chunk of streamResult.textStream) {
        if (isAborted) {
          if (!res.writableEnded) res.end();
          return;
        }
        if (!chunk) continue;
        fullMessage += chunk;
        res.write(`data: ${JSON.stringify({
          type: 'text',
          content: chunk,
        })}\n\n`);
      }

      if (isAborted) {
        if (!res.writableEnded) res.end();
        return;
      }

      res.write(`data: ${JSON.stringify({
        type: 'done',
        message: fullMessage.trim(),
      })}\n\n`);
      res.end();
    } catch (err) {
      if (err?.name === 'AbortError' || isAborted) return;
      console.error('Error generating AI commit message:', err);
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({
          type: 'error',
          message: 'Failed to generate commit message: ' + (err.message || 'Unknown error'),
        })}\n\n`);
        res.end();
      } else {
        res.status(500).json({ error: 'Failed to generate commit message: ' + (err.message || 'Unknown error') });
      }
    }
  };
}
