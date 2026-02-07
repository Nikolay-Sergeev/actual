// @ts-strict-ignore
import * as asyncStorage from '../../platform/server/asyncStorage';
import * as db from '../db';
import { runHandler } from '../mutators';
import * as mockSyncServer from '../tests/mockSyncServer';

import { app } from './app';
import { syncAccount } from './sync';
import * as bankSync from './sync';

describe('Enable Banking integration (loot-core)', () => {
  beforeEach(async () => {
    await global.emptyDatabase()();
    vi.spyOn(asyncStorage, 'getItem').mockResolvedValue('test-token');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete mockSyncServer.handlers['/enablebanking/transactions'];
    delete mockSyncServer.handlers['/enablebanking/remove-account'];
  });

  test('syncAccount uses enablebanking provider route', async () => {
    const transactionsHandler = vi.fn(() => ({
      transactions: {
        all: [],
        booked: [],
        pending: [],
      },
      balances: [],
      startingBalance: 0,
    }));
    mockSyncServer.handlers['/enablebanking/transactions'] =
      transactionsHandler;

    await db.insertAccount({
      id: 'acc-enablebanking',
      name: 'Enable Banking Account',
      offbudget: 0,
      account_id: 'remote-account-id',
      bank: 'bank-row-id',
      account_sync_source: 'enableBanking',
    });

    await db.insertTransaction({
      id: 'existing-transaction',
      account: 'acc-enablebanking',
      amount: 100,
      date: '2024-01-15',
    });

    await syncAccount(
      undefined,
      undefined,
      'acc-enablebanking',
      'remote-account-id',
      'enablebanking-session-id',
      '2024-01-01',
    );

    expect(transactionsHandler).toHaveBeenCalledTimes(1);
    expect(transactionsHandler).toHaveBeenCalledWith({
      accountId: 'remote-account-id',
      continuationKey: null,
      includeBalance: true,
      sessionId: 'enablebanking-session-id',
      startDate: '2024-01-01',
    });
  });

  test('enablebanking-accounts-link stores enableBanking source and session bank id', async () => {
    const syncSpy = vi
      .spyOn(bankSync, 'syncAccount')
      .mockResolvedValue({ added: [], updated: [], updatedPreview: [] });

    await runHandler(
      app.handlers['enablebanking-accounts-link'],
      {
        sessionId: 'session-123',
        externalAccount: {
          account_id: 'remote-account-1',
          name: 'Primary Account',
          institution: 'Test Institution',
          balance: 0,
        },
      },
      { name: 'enablebanking-accounts-link' },
    );

    const account = await db.first<{
      id: string;
      bank: string | null;
      account_sync_source: string | null;
      account_id: string | null;
    }>(
      'SELECT id, bank, account_sync_source, account_id FROM accounts WHERE account_id = ?',
      ['remote-account-1'],
    );
    expect(account).toBeTruthy();
    if (!account) {
      throw new Error('Expected linked account to exist');
    }
    expect(account.account_sync_source).toBe('enableBanking');
    expect(account.account_id).toBe('remote-account-1');

    const bank = await db.first<{ bank_id: string; name: string }>(
      'SELECT bank_id, name FROM banks WHERE id = ?',
      [account.bank],
    );
    expect(bank).toMatchObject({
      bank_id: 'session-123',
      name: 'Test Institution',
    });

    expect(syncSpy).toHaveBeenCalledWith(
      undefined,
      undefined,
      account.id,
      'remote-account-1',
      'session-123',
      undefined,
      undefined,
    );
  });

  test('account-unlink removes upstream session when last enableBanking account is unlinked', async () => {
    const removeAccountHandler = vi.fn(() => ({ message: 'OK' }));
    mockSyncServer.handlers['/enablebanking/remove-account'] =
      removeAccountHandler;

    await db.insertWithUUID('banks', {
      id: 'bank-row',
      bank_id: 'session-remove-me',
      name: 'Test Institution',
    });

    await db.insertAccount({
      id: 'acc-to-unlink',
      name: 'To unlink',
      offbudget: 0,
      account_id: 'remote-account-2',
      bank: 'bank-row',
      account_sync_source: 'enableBanking',
    });

    await runHandler(
      app.handlers['account-unlink'],
      { id: 'acc-to-unlink' },
      { name: 'account-unlink' },
    );

    const unlinkedAccount = await db.first(
      'SELECT account_id, bank, account_sync_source FROM accounts WHERE id = ?',
      ['acc-to-unlink'],
    );
    expect(unlinkedAccount).toMatchObject({
      account_id: null,
      bank: null,
      account_sync_source: null,
    });

    expect(removeAccountHandler).toHaveBeenCalledTimes(1);
    expect(removeAccountHandler).toHaveBeenCalledWith({
      sessionId: 'session-remove-me',
    });
  });

  test('account-unlink does not remove upstream session when other linked accounts remain', async () => {
    const removeAccountHandler = vi.fn(() => ({ message: 'OK' }));
    mockSyncServer.handlers['/enablebanking/remove-account'] =
      removeAccountHandler;

    await db.insertWithUUID('banks', {
      id: 'bank-shared',
      bank_id: 'session-shared',
      name: 'Shared Institution',
    });

    await db.insertAccount({
      id: 'acc-unlink-1',
      name: 'Linked 1',
      offbudget: 0,
      account_id: 'remote-a',
      bank: 'bank-shared',
      account_sync_source: 'enableBanking',
    });

    await db.insertAccount({
      id: 'acc-unlink-2',
      name: 'Linked 2',
      offbudget: 0,
      account_id: 'remote-b',
      bank: 'bank-shared',
      account_sync_source: 'enableBanking',
    });

    await runHandler(
      app.handlers['account-unlink'],
      { id: 'acc-unlink-1' },
      { name: 'account-unlink' },
    );

    expect(removeAccountHandler).not.toHaveBeenCalled();
  });
});
