import {
  buildFileContext,
  buildDirectoryContext,
  buildMessages,
} from '../src/ai-chat/message-builder.js';

describe('ai-chat/message-builder', () => {
  describe('buildFileContext', () => {
    test('includes url path in context', () => {
      const result = buildFileContext('notes/test.md', 'Test content');
      expect(result).toContain('notes/test.md');
      expect(result).toContain('vault/notes/test.md');
    });

    test('includes document content', () => {
      const result = buildFileContext('test.md', '# Hello World');
      expect(result).toContain('# Hello World');
    });

    test('includes today\'s date', () => {
      const today = new Date().toISOString().split('T')[0];
      const result = buildFileContext('test.md', 'content');
      expect(result).toContain(today);
    });

    test('includes available tool descriptions', () => {
      const result = buildFileContext('test.md', 'content');
      expect(result).toContain('edit_file');
      expect(result).toContain('create_file');
      expect(result).toContain('delete_file');
      expect(result).toContain('query_database');
      expect(result).toContain('run_command');
    });

    test('shows placeholder when document content is empty', () => {
      const result = buildFileContext('test.md', '');
      expect(result).toContain('(No document content available)');
    });

    test('shows placeholder when document content is null', () => {
      const result = buildFileContext('test.md', null);
      expect(result).toContain('(No document content available)');
    });

    test('includes document content between delimiters', () => {
      const result = buildFileContext('test.md', 'my content here');
      expect(result).toContain('---CURRENT DOCUMENT CONTENT---');
      expect(result).toContain('---END DOCUMENT---');
      expect(result).toContain('my content here');
    });

    test('returns a string', () => {
      expect(typeof buildFileContext('test.md', 'content')).toBe('string');
    });
  });

  describe('buildDirectoryContext', () => {
    test('includes url path in context', () => {
      const result = buildDirectoryContext('notes/', 'file1.md\nfile2.md');
      expect(result).toContain('notes/');
    });

    test('uses root path when url is empty/null', () => {
      const result = buildDirectoryContext('', 'files');
      expect(result).toContain('/');
    });

    test('includes directory content', () => {
      const result = buildDirectoryContext('notes/', '- file1.md\n- file2.md');
      expect(result).toContain('- file1.md');
    });

    test('includes query_database tool description', () => {
      const result = buildDirectoryContext('notes/', 'content');
      expect(result).toContain('query_database');
    });

    test('shows placeholder when directory content is null', () => {
      const result = buildDirectoryContext('notes/', null);
      expect(result).toContain('(No directory content available)');
    });

    test('includes today\'s date', () => {
      const today = new Date().toISOString().split('T')[0];
      const result = buildDirectoryContext('notes/', 'content');
      expect(result).toContain(today);
    });

    test('returns a string', () => {
      expect(typeof buildDirectoryContext('notes/', 'content')).toBe('string');
    });
  });

  describe('buildMessages', () => {
    test('adds user message at the end', () => {
      const result = buildMessages('system', [], 'Hello AI');
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual({ role: 'user', content: 'Hello AI' });
    });

    test('includes system context in returned object', () => {
      const result = buildMessages('my system prompt', [], 'Hello');
      expect(result.system).toBe('my system prompt');
    });

    test('includes history messages before the user message', () => {
      const history = [
        { role: 'user', content: 'previous question' },
        { role: 'assistant', content: 'previous answer' },
      ];
      const result = buildMessages('system', history, 'new question');
      expect(result.messages).toHaveLength(3);
      expect(result.messages[0].content).toBe('previous question');
      expect(result.messages[1].content).toBe('previous answer');
      expect(result.messages[2].content).toBe('new question');
    });

    test('skips empty history messages', () => {
      const history = [
        { role: 'user', content: 'valid message' },
        { role: 'assistant', content: '' },
        { role: 'user', content: '   ' },
      ];
      const result = buildMessages('system', history, 'new question');
      // Empty messages are filtered, leaving 'valid message' + 'new question'
      // Consecutive user messages get merged into one
      const allContent = result.messages.map(m => m.content).join(' ');
      expect(allContent).toContain('valid message');
      expect(allContent).toContain('new question');
      // The empty assistant and whitespace-only user messages should not appear
    });

    test('merges consecutive same-role messages', () => {
      const history = [
        { role: 'user', content: 'first part' },
        { role: 'user', content: 'second part' },
      ];
      const result = buildMessages('system', history, 'question');
      // The two consecutive user messages should be merged, + current question
      // After merge: user('first part\n\nsecond part') + user('question') → merged again
      expect(result.messages.length).toBeLessThan(3);
    });

    test('handles null history', () => {
      const result = buildMessages('system', null, 'Hello');
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toBe('Hello');
    });

    test('handles empty history array', () => {
      const result = buildMessages('system', [], 'Hello');
      expect(result.messages).toHaveLength(1);
    });

    test('returns object with system and messages properties', () => {
      const result = buildMessages('system', [], 'Hello');
      expect(result).toHaveProperty('system');
      expect(result).toHaveProperty('messages');
    });
  });
});
