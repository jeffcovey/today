/**
 * get_context's live section: nothing runs on a read-only connection, the
 * weather plugin stays out unless location is shared, plugins get the
 * user's zone, and failures are named rather than dropped silently.
 */

import { jest } from '@jest/globals';
import { readLiveContext, selectContextSources, READ_ONLY_NOTE } from '../src/mcp-live-context.js';

const sources = [
  { sourceId: 'stages/default', plugin: { name: 'stages' }, config: {} },
  { sourceId: 'weather-context/default', plugin: { name: 'weather-context' }, config: {} },
  { sourceId: 'vault-changes/default', plugin: { name: 'vault-changes' }, config: {} },
];
const getSources = async () => ({ sources });

describe('readLiveContext', () => {
  test('runs nothing on a read-only connection', async () => {
    const run = jest.fn();
    expect(await readLiveContext({ readOnly: true, getSources, run, config: {} })).toBe(READ_ONLY_NOTE);
    expect(run).not.toHaveBeenCalled();
  });

  test("leaves weather out when location isn't shared, and passes the user's zone", async () => {
    const calls = [];
    const run = async (entry, opts) => {
      calls.push([entry.pluginName, opts.timezone]);
      if (entry.pluginName === 'vault-changes') return { error: 'timed out' };
      return { data: { context: `${entry.pluginName} says hi` } };
    };
    const config = { mcp: { profile_fields: ['name'] } };
    const text = await readLiveContext({ config, timezone: 'Asia/Tokyo', getSources, run });

    expect(calls).toEqual([['stages', 'Asia/Tokyo'], ['vault-changes', 'Asia/Tokyo']]);
    expect(text).toContain('### stages\n\nstages says hi');
    expect(text).not.toContain('weather-context says hi');
    expect(text).toContain("weather-context/default was left out because it names the user's location");
    expect(text).toContain('vault-changes/default failed or ran too long.');
  });

  test('weather runs when location is shared (the default fields)', () => {
    const { run, skipped } = selectContextSources(sources, {});
    expect(run.map(s => s.sourceId)).toContain('weather-context/default');
    expect(skipped).toEqual([]);
  });
});
