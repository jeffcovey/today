import { jest } from '@jest/globals';
import {
  pushoverSkipReason,
  buildPushoverBody,
  sendPushover
} from '../src/pushover.js';

const settings = {
  enabled: true,
  sound: null,
  priority: null,
  userKey: 'user-key',
  apiToken: 'api-token'
};

function okFetch() {
  return jest.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve('{}') }));
}

describe('pushoverSkipReason', () => {
  it('sends when enabled and both credentials are present', () => {
    expect(pushoverSkipReason(settings)).toBeNull();
  });

  it('skips when disabled in config', () => {
    expect(pushoverSkipReason({ ...settings, enabled: false })).toMatch(/disabled/);
  });

  it('skips when the user key is missing', () => {
    expect(pushoverSkipReason({ ...settings, userKey: '' })).toMatch(/USER_KEY/);
  });

  it('skips when the api token is missing', () => {
    expect(pushoverSkipReason({ ...settings, apiToken: '' })).toMatch(/API_TOKEN/);
  });
});

describe('buildPushoverBody', () => {
  it('carries the credentials, title and message', () => {
    const body = buildPushoverBody({ title: 'Next up', message: 'Wash the dog', settings });
    expect(body.get('token')).toBe('api-token');
    expect(body.get('user')).toBe('user-key');
    expect(body.get('title')).toBe('Next up');
    expect(body.get('message')).toBe('Wash the dog');
  });

  it('omits optional fields that are not configured', () => {
    const body = buildPushoverBody({ message: 'x', settings });
    expect(body.has('title')).toBe(false);
    expect(body.has('sound')).toBe(false);
    expect(body.has('priority')).toBe(false);
  });

  it('includes sound and priority when configured', () => {
    const body = buildPushoverBody({
      message: 'x',
      settings: { ...settings, sound: 'bike', priority: 1 }
    });
    expect(body.get('sound')).toBe('bike');
    expect(body.get('priority')).toBe('1');
  });

  it('includes priority 0, which is a real value rather than absent', () => {
    const body = buildPushoverBody({ message: 'x', settings: { ...settings, priority: 0 } });
    expect(body.get('priority')).toBe('0');
  });
});

describe('sendPushover', () => {
  it('posts to pushover and reports success', async () => {
    const fetchImpl = okFetch();
    const result = await sendPushover({ title: 'T', message: 'M' }, { settings, fetchImpl });

    expect(result).toEqual({ sent: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.pushover.net/1/messages.json');
    expect(init.method).toBe('POST');
    expect(init.body).toContain('user=user-key');
  });

  it('does not reach the network when unconfigured', async () => {
    const fetchImpl = okFetch();
    const result = await sendPushover(
      { message: 'M' },
      { settings: { ...settings, apiToken: '' }, fetchImpl }
    );

    expect(result.sent).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // A notification that cannot be delivered must never stall a phase change,
  // so every failure has to come back as a value rather than a throw.
  it('reports a rejected request instead of throwing', async () => {
    const fetchImpl = jest.fn(() => Promise.reject(new Error('network down')));
    const result = await sendPushover({ message: 'M' }, { settings, fetchImpl });

    expect(result.sent).toBe(false);
    expect(result.reason).toBe('network down');
  });

  it('reports a non-ok response instead of throwing', async () => {
    const fetchImpl = jest.fn(() => Promise.resolve({
      ok: false,
      status: 400,
      text: () => Promise.resolve('{"errors":["application token is invalid"]}')
    }));
    const result = await sendPushover({ message: 'M' }, { settings, fetchImpl });

    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/400/);
    expect(result.detail).toMatch(/invalid/);
  });

  it('gives up rather than hanging when the request stalls', async () => {
    const fetchImpl = jest.fn((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }));
    const result = await sendPushover({ message: 'M' }, { settings, fetchImpl, timeoutMs: 20 });

    expect(result.sent).toBe(false);
    expect(result.reason).toBe('timed out');
  });

  it('refuses an empty message', async () => {
    const fetchImpl = okFetch();
    const result = await sendPushover({ title: 'T', message: '' }, { settings, fetchImpl });

    expect(result.sent).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
