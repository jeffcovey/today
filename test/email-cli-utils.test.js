import { jest } from '@jest/globals';
import {
  addExactSourceCondition,
  getImapPasswordEnvKey,
  newestUids,
  rankSearchResults,
  searchableFolders,
  withConnectedImapClient
} from '../src/email-cli-utils.js';

describe('email CLI utils', () => {
  test('addExactSourceCondition accepts a bare source name and its full id', () => {
    const conditions = [];
    const params = [];

    addExactSourceCondition(conditions, params, 'icloud');

    expect(conditions).toEqual(['(source = ? OR source = ?)']);
    expect(params).toEqual(['icloud', 'imap-email/icloud']);
  });

  test('addExactSourceCondition keeps full source ids exact', () => {
    const conditions = [];
    const params = [];

    addExactSourceCondition(conditions, params, 'imap-email/icloud');

    expect(conditions).toEqual(['source = ?']);
    expect(params).toEqual(['imap-email/icloud']);
  });

  test('getImapPasswordEnvKey follows the encrypted-settings naming contract', () => {
    expect(getImapPasswordEnvKey('work-mail')).toBe('TODAY_IMAP_EMAIL_WORK_MAIL_PASSWORD');
    expect(getImapPasswordEnvKey('me.com')).toBe('TODAY_IMAP_EMAIL_ME_COM_PASSWORD');
  });

  test('withConnectedImapClient logs out after successful actions', async () => {
    const client = {
      connect: jest.fn().mockResolvedValue(undefined),
      logout: jest.fn().mockResolvedValue(undefined),
    };

    const result = await withConnectedImapClient(client, async () => 'ok');

    expect(result).toBe('ok');
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.logout).toHaveBeenCalledTimes(1);
  });

  test('withConnectedImapClient logs out when the action throws', async () => {
    const client = {
      connect: jest.fn().mockResolvedValue(undefined),
      logout: jest.fn().mockResolvedValue(undefined),
    };

    await expect(
      withConnectedImapClient(client, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.logout).toHaveBeenCalledTimes(1);
  });

  test('withConnectedImapClient does not logout when connect fails', async () => {
    const client = {
      connect: jest.fn().mockRejectedValue(new Error('connect failed')),
      logout: jest.fn().mockResolvedValue(undefined),
    };

    await expect(
      withConnectedImapClient(client, async () => 'unused')
    ).rejects.toThrow('connect failed');

    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.logout).not.toHaveBeenCalled();
  });
});

describe('newestUids', () => {
  it('keeps the highest uids, not the lowest', () => {
    expect(newestUids([1, 2, 3, 4, 5], 2)).toEqual([4, 5]);
  });

  it('sorts numerically before slicing', () => {
    // A server may return them unordered; string sort would put 100 before 9.
    expect(newestUids([9, 100, 11, 2], 2)).toEqual([11, 100]);
  });

  it('returns everything when there are fewer than the limit', () => {
    expect(newestUids([7, 3], 10)).toEqual([3, 7]);
  });

  it('handles an empty or missing list', () => {
    expect(newestUids([], 5)).toEqual([]);
    expect(newestUids(undefined, 5)).toEqual([]);
  });

  it('returns all uids when the limit is not a usable number', () => {
    expect(newestUids([3, 1, 2], NaN)).toEqual([1, 2, 3]);
    expect(newestUids([3, 1, 2], 0)).toEqual([1, 2, 3]);
  });
});

describe('rankSearchResults', () => {
  const older = { subject: 'old', date: '2019-05-02T00:00:00Z' };
  const newer = { subject: 'new', date: '2026-03-11T00:00:00Z' };
  const middle = { subject: 'mid', date: '2024-01-01T00:00:00Z' };

  it('orders newest first', () => {
    expect(rankSearchResults([older, newer, middle], 10).map(r => r.subject))
      .toEqual(['new', 'mid', 'old']);
  });

  // The bug in #522: results were truncated per folder before ranking, so a
  // folder full of old mail could fill the quota and hide recent matches.
  it('truncates only after ranking, so recent results survive', () => {
    const manyOld = Array.from({ length: 50 }, (_, i) => ({
      subject: `old-${i}`, date: `2019-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`
    }));
    const ranked = rankSearchResults([...manyOld, newer], 5);
    expect(ranked[0].subject).toBe('new');
    expect(ranked).toHaveLength(5);
  });

  it('puts undated results last rather than dropping them', () => {
    const undated = { subject: 'undated' };
    const ranked = rankSearchResults([undated, newer], 10);
    expect(ranked.map(r => r.subject)).toEqual(['new', 'undated']);
  });

  it('does not mutate the input', () => {
    const input = [older, newer];
    rankSearchResults(input, 1);
    expect(input.map(r => r.subject)).toEqual(['old', 'new']);
  });
});

describe('searchableFolders', () => {
  it('returns every selectable folder, not a fixed few', () => {
    const folders = Array.from({ length: 12 }, (_, i) => ({ path: `Folder${i}` }));
    expect(searchableFolders(folders)).toHaveLength(12);
  });

  it('skips namespace containers, Notes, and unselectable folders', () => {
    const folders = [
      { path: 'INBOX' },
      { path: 'Archive' },
      { path: '[Gmail]' },
      { path: 'Notes' },
      { path: 'Containers', flags: new Set(['\\Noselect']) }
    ];
    expect(searchableFolders(folders)).toEqual(['INBOX', 'Archive']);
  });

  it('handles a missing folder list', () => {
    expect(searchableFolders(undefined)).toEqual([]);
  });
});
