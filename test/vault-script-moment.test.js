import { getVaultScriptMoment } from '../src/vault-script-moment.js';

describe('getVaultScriptMoment', () => {
  afterEach(() => {
    getVaultScriptMoment(undefined);
  });

  // Regression: the time-tracking widget showed an 11:16 AM Eastern entry as
  // "3:16 PM" because the web server formatted it in the process zone (UTC).
  test('formats offset timestamps in the configured timezone', () => {
    const moment = getVaultScriptMoment('America/New_York');
    expect(moment('2026-09-20T11:16:57-04:00').format('h:mm A')).toBe('11:16 AM');
    expect(moment('2026-09-20T15:16:57Z').format('h:mm A')).toBe('11:16 AM');
  });

  test('moment() reports the current date in the configured timezone', () => {
    const moment = getVaultScriptMoment('Pacific/Kiritimati'); // UTC+14
    const expected = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Kiritimati' }).format(new Date());
    expect(moment().format('YYYY-MM-DD')).toBe(expected);
  });

  test('picks up a changed timezone on the next call', () => {
    getVaultScriptMoment('America/New_York');
    const moment = getVaultScriptMoment('Europe/Paris');
    expect(moment('2026-09-20T11:16:57-04:00').format('HH:mm')).toBe('17:16');
  });

  test('keeps diffs and written offsets correct', () => {
    const moment = getVaultScriptMoment('America/New_York');
    const start = moment('2026-09-20T11:16:57-04:00');
    expect(moment('2026-09-20T12:17:43-04:00').diff(start, 'minutes')).toBe(60);
    expect(start.format('YYYY-MM-DDTHH:mm:ssZ')).toBe('2026-09-20T11:16:57-04:00');
  });

  test('unknown timezone falls back without throwing', () => {
    const moment = getVaultScriptMoment('Not/AZone');
    expect(moment('2026-09-20T11:16:57-04:00').isValid()).toBe(true);
  });
});
