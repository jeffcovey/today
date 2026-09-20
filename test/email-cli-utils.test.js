import { jest } from '@jest/globals';
import {
  addExactSourceCondition,
  getImapPasswordEnvKey,
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
