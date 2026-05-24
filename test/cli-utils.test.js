import { jest } from '@jest/globals';
import {
  colors,
  printStatus,
  printError,
  printInfo,
  printWarning,
  printHeader,
  showSourceError,
  showSourceFilterError,
} from '../src/cli-utils.js';

describe('cli-utils', () => {
  let consoleLogSpy;
  let consoleErrorSpy;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe('colors', () => {
    test('exposes color functions', () => {
      expect(typeof colors.red).toBe('function');
      expect(typeof colors.green).toBe('function');
      expect(typeof colors.blue).toBe('function');
      expect(typeof colors.bold).toBe('function');
    });

    test('color functions return strings', () => {
      expect(typeof colors.red('test')).toBe('string');
      expect(typeof colors.green('test')).toBe('string');
    });

    test('color functions include the input text', () => {
      // ANSI codes may wrap the text, but the text should still be present
      expect(colors.red('hello')).toContain('hello');
      expect(colors.bold('world')).toContain('world');
    });
  });

  describe('printStatus', () => {
    test('logs a message to console', () => {
      printStatus('Everything is fine');
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const output = consoleLogSpy.mock.calls[0][0];
      expect(output).toContain('Everything is fine');
    });

    test('includes a check mark symbol', () => {
      printStatus('Done');
      const output = consoleLogSpy.mock.calls[0][0];
      expect(output).toContain('✓');
    });
  });

  describe('printError', () => {
    test('logs to stderr', () => {
      printError('Something went wrong');
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      const output = consoleErrorSpy.mock.calls[0][0];
      expect(output).toContain('Something went wrong');
    });

    test('includes a cross mark symbol', () => {
      printError('Error');
      const output = consoleErrorSpy.mock.calls[0][0];
      expect(output).toContain('✗');
    });
  });

  describe('printInfo', () => {
    test('logs a message to console', () => {
      printInfo('Some information');
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const output = consoleLogSpy.mock.calls[0][0];
      expect(output).toContain('Some information');
    });

    test('includes an info symbol', () => {
      printInfo('Info');
      const output = consoleLogSpy.mock.calls[0][0];
      expect(output).toContain('ℹ');
    });
  });

  describe('printWarning', () => {
    test('logs a message to console', () => {
      printWarning('Be careful');
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const output = consoleLogSpy.mock.calls[0][0];
      expect(output).toContain('Be careful');
    });

    test('includes a warning symbol', () => {
      printWarning('Warning');
      const output = consoleLogSpy.mock.calls[0][0];
      expect(output).toContain('⚠');
    });
  });

  describe('printHeader', () => {
    test('logs the header message', () => {
      printHeader('My Section');
      const allCalls = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(allCalls).toContain('My Section');
    });

    test('logs decorative separator lines', () => {
      printHeader('Test');
      const allCalls = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(allCalls).toContain('═══');
    });

    test('logs multiple lines (blank + separator + message + separator)', () => {
      printHeader('Test');
      expect(consoleLogSpy).toHaveBeenCalledTimes(4);
    });
  });

  describe('showSourceError', () => {
    test('prints the error message', () => {
      showSourceError('Source not found');
      const errorOutput = consoleErrorSpy.mock.calls[0][0];
      expect(errorOutput).toContain('Source not found');
    });

    test('prints available sources when provided', () => {
      showSourceError('Source not found', [
        { sourceId: 'source-a', enabled: true },
        { sourceId: 'source-b', enabled: false },
      ]);
      const allOutput = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(allOutput).toContain('source-a');
      expect(allOutput).toContain('source-b');
    });

    test('prints config command suggestion', () => {
      showSourceError('Error');
      const allOutput = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(allOutput).toContain('bin/plugins configure');
    });

    test('uses custom config command when provided', () => {
      showSourceError('Error', [], { configCommand: 'custom-command' });
      const allOutput = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(allOutput).toContain('custom-command');
    });

    test('handles no available sources', () => {
      showSourceError('Error', []);
      // Should not throw, just print error and config hint
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });

  describe('showSourceFilterError', () => {
    test('prints the source filter that did not match', () => {
      showSourceFilterError('my-source', 'tasks', []);
      const allOutput = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(allOutput).toContain('my-source');
    });

    test('prints plugin type in output', () => {
      showSourceFilterError('src', 'time-logs', [
        { sourceId: 'toggl', enabled: true },
      ]);
      const allOutput = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(allOutput).toContain('time-logs');
      expect(allOutput).toContain('toggl');
    });

    test('handles empty sources list', () => {
      showSourceFilterError('src', 'tasks', []);
      const allOutput = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(allOutput).toContain('No tasks plugins found');
    });

    test('uses custom config command', () => {
      showSourceFilterError('src', 'tasks', [], { configCommand: 'custom-setup' });
      const allOutput = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(allOutput).toContain('custom-setup');
    });
  });
});
