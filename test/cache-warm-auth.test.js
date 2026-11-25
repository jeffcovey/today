import { warmToken, warmRequestAllowed } from '../src/cache-warm-auth.js';

const SECRET = 'test-session-secret';

describe('warmRequestAllowed', () => {
  test.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('the local machine (%s) needs no token', (ip) => {
    expect(warmRequestAllowed(ip, undefined, SECRET)).toBe(true);
    expect(warmRequestAllowed(ip, undefined, undefined)).toBe(true);
  });

  test('another container with the right token is allowed', () => {
    expect(warmRequestAllowed('172.18.0.5', warmToken(SECRET), SECRET)).toBe(true);
  });

  test.each([
    ['no token', undefined],
    ['a wrong token', warmToken('other-secret')],
    ['the secret itself', SECRET],
    ['an empty token', '']
  ])('another container with %s is refused', (_label, token) => {
    expect(warmRequestAllowed('172.18.0.5', token, SECRET)).toBe(false);
  });

  test('without a session secret, only the local machine is allowed', () => {
    expect(warmToken(undefined)).toBe('');
    expect(warmRequestAllowed('172.18.0.5', '', undefined)).toBe(false);
  });
});

describe('warmToken', () => {
  test('is stable, and never the secret itself', () => {
    expect(warmToken(SECRET)).toBe(warmToken(SECRET));
    expect(warmToken(SECRET)).not.toContain(SECRET);
    expect(warmToken(SECRET)).toMatch(/^[0-9a-f]{64}$/);
  });
});

test('a token with as many characters but more bytes is refused, not thrown on', () => {
  const token = 'é'.repeat(warmToken(SECRET).length);
  expect(() => warmRequestAllowed('172.18.0.5', token, SECRET)).not.toThrow();
  expect(warmRequestAllowed('172.18.0.5', token, SECRET)).toBe(false);
});
