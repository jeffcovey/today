import { getVaultScriptMoment } from '../src/vault-script-moment.js';

describe('getVaultScriptMoment', () => {
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
    expect(moment('2026-09-20 11:16:57').format('YYYY-MM-DDTHH:mm:ssZ')).toBe('2026-09-20T11:16:57-04:00');
  });

  test('unknown timezone falls back without throwing', () => {
    const moment = getVaultScriptMoment('Not/AZone');
    expect(moment('2026-09-20T11:16:57-04:00').isValid()).toBe(true);
  });

  test('forwards the moment statics vault scripts use', () => {
    const moment = getVaultScriptMoment('America/New_York');
    const unixMoment = moment.unix(0);
    expect(moment.duration(90, 'minutes').asMinutes()).toBe(90);
    expect(moment.isMoment(unixMoment)).toBe(true);
    expect(moment.utc('2026-09-20T15:16:57Z').format('HH:mm')).toBe('15:16');
    expect(typeof moment.locale).toBe('function');
    expect(moment.tz.zone('America/New_York')).not.toBeNull();
  });

  test('keeps interleaved renders isolated by facade', async () => {
    const newYorkMoment = getVaultScriptMoment('America/New_York');
    const parisMoment = getVaultScriptMoment('Europe/Paris');

    const [newYorkTimes, parisTimes] = await Promise.all([
      (async () => {
        const first = newYorkMoment('2026-09-20T15:16:57Z').format('HH:mm');
        await Promise.resolve();
        const second = newYorkMoment('2026-09-20T15:16:57Z').format('HH:mm');
        return [first, second];
      })(),
      (async () => {
        await Promise.resolve();
        const first = parisMoment('2026-09-20T15:16:57Z').format('HH:mm');
        await Promise.resolve();
        const second = parisMoment('2026-09-20T15:16:57Z').format('HH:mm');
        return [first, second];
      })(),
    ]);

    expect(newYorkTimes).toEqual(['11:16', '11:16']);
    expect(parisTimes).toEqual(['17:16', '17:16']);
  });
});
