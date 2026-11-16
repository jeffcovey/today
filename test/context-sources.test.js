import { jest } from '@jest/globals';

// getContextSources: context gathering runs the `context` plugins plus any
// source of another plugin that declares a `context_files` setting and lists
// at least one file (user-scripts).

jest.unstable_mockModule('../src/config.js', () => ({
  getFullConfig: jest.fn().mockReturnValue({
    plugins: {
      'weather-context': { default: { enabled: true } },
      'user-scripts': {
        reading: { enabled: true, context_files: ['today/context/reading.md'] },
        plain: { enabled: true },
        off: { enabled: false, context_files: ['x.md'] },
      },
    },
  }),
  getConfig: jest.fn(),
  getTimezone: jest.fn().mockReturnValue('America/New_York'),
  getVaultPath: jest.fn().mockReturnValue('vault'),
  getAbsoluteVaultPath: jest.fn().mockReturnValue('/tmp/test-vault'),
  getConfigPath: jest.fn().mockReturnValue('config.toml'),
}));

const { getContextSources, getSourceContextFiles } = await import('../src/plugin-loader.js');

describe('getContextSources', () => {
  test('adds enabled user-scripts sources that list context files', async () => {
    const { sources } = await getContextSources();
    const ids = sources.map(s => s.sourceId);
    expect(ids).toContain('weather-context/default');
    expect(ids).toContain('user-scripts/reading');
    expect(ids).not.toContain('user-scripts/plain');
    expect(ids).not.toContain('user-scripts/off');
  });

  test('passes the source config (with defaults) and honors the filter', async () => {
    const { sources } = await getContextSources('user-scripts');
    expect(sources.map(s => s.sourceId)).toEqual(['user-scripts/reading']);
    expect(sources[0].plugin.name).toBe('user-scripts');
    expect(sources[0].config.context_files).toEqual(['today/context/reading.md']);
    expect(sources[0].config.timeout_seconds).toBe(30);
  });
});

describe('getSourceContextFiles', () => {
  test('takes a list or a single string, and drops blanks', () => {
    expect(getSourceContextFiles({ context_files: ['a.md', ' ', 'b.md '] })).toEqual(['a.md', 'b.md']);
    expect(getSourceContextFiles({ context_files: 'a.md' })).toEqual(['a.md']);
    expect(getSourceContextFiles({})).toEqual([]);
    expect(getSourceContextFiles(null)).toEqual([]);
  });
});
