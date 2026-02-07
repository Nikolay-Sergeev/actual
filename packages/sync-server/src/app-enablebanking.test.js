import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getAccountDb } from './account-db';
import { handlers as app } from './app-enablebanking/app-enablebanking';
import { SecretName, secretsService } from './services/secrets-service';

vi.mock('jws', () => ({
  default: {
    sign: vi.fn(() => 'signed.jwt.token'),
  },
}));

async function authenticatedPost(path, body = {}) {
  return request(app)
    .post(path)
    .set('x-actual-token', 'valid-token')
    .send(body);
}

function setEnableBankingSecrets() {
  secretsService.set(SecretName.enablebanking_applicationId, 'test-app-id');
  secretsService.set(
    SecretName.enablebanking_privateKey,
    '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
  );
  secretsService.set(SecretName.enablebanking_environment, 'SANDBOX');
}

describe('app-enablebanking', () => {
  beforeEach(() => {
    getAccountDb().mutate('DELETE FROM secrets');
    setEnableBankingSecrets();
    global.fetch = vi.fn();
    vi.clearAllMocks();
  });

  it('signs JWT with expected RS256 header and bounded TTL', async () => {
    const jws = await import('jws');

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ aspsps: [] }),
    });

    const res = await authenticatedPost('/aspsps', {
      country: 'LT',
    });

    expect(res.statusCode).toBe(200);
    expect(jws.default.sign).toHaveBeenCalledTimes(1);

    const signInput = jws.default.sign.mock.calls[0][0];
    expect(signInput.header).toMatchObject({
      typ: 'JWT',
      alg: 'RS256',
      kid: 'test-app-id',
    });
    expect(signInput.payload.iss).toBe('enablebanking.com');
    expect(signInput.payload.aud).toBe('api.enablebanking.com');
    expect(signInput.payload.exp).toBeGreaterThan(signInput.payload.iat);
    expect(signInput.payload.exp - signInput.payload.iat).toBeLessThanOrEqual(
      24 * 60 * 60,
    );

    const [requestUrl, requestOptions] = global.fetch.mock.calls[0];
    expect(requestUrl).toContain('/aspsps?country=LT');
    expect(requestOptions.headers.Authorization).toBe(
      'Bearer signed.jwt.token',
    );
  });

  it('normalizes one-line PEM private key before JWT signing', async () => {
    const jws = await import('jws');
    secretsService.set(
      SecretName.enablebanking_privateKey,
      '-----BEGIN PRIVATE KEY----- abc def -----END PRIVATE KEY-----',
    );

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ aspsps: [] }),
    });

    const res = await authenticatedPost('/aspsps', {
      country: 'GR',
    });

    expect(res.statusCode).toBe(200);
    expect(jws.default.sign).toHaveBeenCalledTimes(1);

    const signInput = jws.default.sign.mock.calls[0][0];
    expect(signInput.privateKey).toContain('-----BEGIN PRIVATE KEY-----\n');
    expect(signInput.privateKey).toContain('\n-----END PRIVATE KEY-----');
    expect(signInput.privateKey).not.toContain(
      '-----BEGIN PRIVATE KEY----- abc def -----END PRIVATE KEY-----',
    );
  });

  it('stores callback code and authorizes on poll-auth by state', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        session_id: 'session-123',
        aspsp: { name: 'Test Bank', country: 'LT' },
        accounts: [
          { uid: 'acc-1', identification_hash: 'hash-1', name: 'A' },
          { identification_hash: 'hash-without-uid', name: 'B' },
        ],
      }),
    });

    const callbackRes = await request(app).get(
      '/callback?state=state-123&code=auth-code-123',
    );
    expect(callbackRes.statusCode).toBe(200);

    const pollRes = await authenticatedPost('/poll-auth', {
      state: 'state-123',
    });
    expect(pollRes.statusCode).toBe(200);
    expect(pollRes.body.status).toBe('ok');
    expect(pollRes.body.data.status).toBe('authorized');
    expect(pollRes.body.data.session_id).toBe('session-123');
    expect(pollRes.body.data.accounts).toHaveLength(1);
    expect(pollRes.body.data.accounts[0]).toMatchObject({
      account_id: 'acc-1',
      name: 'A',
      institution: 'Test Bank',
      identification_hash: 'hash-1',
    });

    const secondPoll = await authenticatedPost('/poll-auth', {
      state: 'state-123',
    });
    expect(secondPoll.statusCode).toBe(200);
    expect(secondPoll.body.data.status).toBe('pending');
  });

  it('authorizes on poll-auth by authorizationId when state is not provided', async () => {
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          aspsps: [
            {
              name: 'Test Bank',
              country: 'LT',
              maximum_consent_validity: 86400,
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          url: 'https://enablebanking.com/auth',
          authorization_id: 'auth-xyz',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          session_id: 'session-xyz',
          aspsp: { name: 'Test Bank', country: 'LT' },
          accounts: [
            { uid: 'acc-1', identification_hash: 'hash-1', name: 'A' },
          ],
        }),
      });

    const createRes = await authenticatedPost('/create-auth', {
      aspsp: { name: 'Test Bank', country: 'LT' },
      access: {
        balances: true,
        transactions: true,
        valid_until: '2026-02-01T00:00:00.000Z',
      },
      redirectUrl: 'https://example.com/callback',
      state: 'state-xyz',
      psuType: 'personal',
    });

    expect(createRes.statusCode).toBe(200);
    expect(createRes.body.data.authorization_id).toBe('auth-xyz');

    await request(app).get('/callback?state=state-xyz&code=auth-code-xyz');

    const pollRes = await authenticatedPost('/poll-auth', {
      authorizationId: 'auth-xyz',
    });

    expect(pollRes.statusCode).toBe(200);
    expect(pollRes.body.status).toBe('ok');
    expect(pollRes.body.data.status).toBe('authorized');
    expect(pollRes.body.data.session_id).toBe('session-xyz');
  });

  it('prefers configured redirectUrl secret over request redirectUrl', async () => {
    secretsService.set(
      SecretName.enablebanking_redirectUrl,
      'https://public.actual.example/enablebanking/callback',
    );

    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          aspsps: [
            {
              name: 'Test Bank',
              country: 'LT',
              maximum_consent_validity: 86400,
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          url: 'https://enablebanking.com/auth',
          authorization_id: 'auth-override',
        }),
      });

    const res = await authenticatedPost('/create-auth', {
      aspsp: { name: 'Test Bank', country: 'LT' },
      access: {
        balances: true,
        transactions: true,
        valid_until: '2026-02-01T00:00:00.000Z',
      },
      redirectUrl: 'http://localhost:5006/enablebanking/callback',
      state: 'state-override',
      psuType: 'personal',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.redirect_url).toBe(
      'https://public.actual.example/enablebanking/callback',
    );

    const [, authOptions] = global.fetch.mock.calls[1];
    const authBody = JSON.parse(authOptions.body);
    expect(authBody.redirect_url).toBe(
      'https://public.actual.example/enablebanking/callback',
    );
  });

  it('caps valid_until in create-auth by ASPSP maximum consent validity', async () => {
    vi.useFakeTimers();
    try {
      const now = new Date('2026-01-01T00:00:00.000Z');
      vi.setSystemTime(now);

      global.fetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            aspsps: [
              {
                name: 'Test Bank',
                country: 'LT',
                maximum_consent_validity: 3600,
              },
            ],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            url: 'https://enablebanking.com/auth',
            authorization_id: 'auth-123',
          }),
        });

      const res = await authenticatedPost('/create-auth', {
        aspsp: { name: 'Test Bank', country: 'LT' },
        access: {
          balances: true,
          transactions: true,
          valid_until: '2026-02-01T00:00:00.000Z',
        },
        redirectUrl: 'https://example.com/callback',
        state: 'state-123',
        psuType: 'personal',
      });

      expect(res.statusCode).toBe(200);
      expect(global.fetch).toHaveBeenCalledTimes(2);

      const [, authOptions] = global.fetch.mock.calls[1];
      const authBody = JSON.parse(authOptions.body);
      const validUntilMs = Date.parse(authBody.access.valid_until);
      expect(validUntilMs).toBeLessThanOrEqual(now.getTime() + 3600 * 1000);
      expect(validUntilMs).toBeGreaterThanOrEqual(now.getTime());
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not hard-cap valid_until to default when ASPSP metadata lookup fails', async () => {
    global.fetch
      .mockRejectedValueOnce(new Error('ASPSP lookup failed'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          url: 'https://enablebanking.com/auth',
          authorization_id: 'auth-no-cap',
        }),
      });

    const requestedValidUntil = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const res = await authenticatedPost('/create-auth', {
      aspsp: { name: 'Test Bank', country: 'LT' },
      access: {
        balances: true,
        transactions: true,
        valid_until: requestedValidUntil,
      },
      redirectUrl: 'https://example.com/callback',
      state: 'state-no-cap',
      psuType: 'personal',
    });

    expect(res.statusCode).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(2);

    const [, authOptions] = global.fetch.mock.calls[1];
    const authBody = JSON.parse(authOptions.body);
    expect(authBody.access.valid_until).toBe(requestedValidUntil);
  });

  it('uses accounts_data fallback when session accounts list is empty', async () => {
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          session_id: 'session-accounts',
          aspsp: { name: 'Test Bank', country: 'LT' },
          accounts: [],
          accounts_data: [{ uid: 'acc-fallback', identification_hash: 'h-1' }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          uid: 'acc-fallback',
          name: 'Fallback Account',
          identification_hash: 'h-1',
        }),
      });

    const res = await authenticatedPost('/accounts', {
      sessionId: 'session-accounts',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.data.accounts).toHaveLength(1);
    expect(res.body.data.accounts[0]).toMatchObject({
      account_id: 'acc-fallback',
      name: 'Fallback Account',
      identification_hash: 'h-1',
    });
  });

  it('autopaginates transactions when continuation key is not provided', async () => {
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          transactions: [
            {
              status: 'BOOK',
              booking_date: '2024-01-02',
              creditor: { name: 'Store 1' },
              transaction_amount: { amount: '-10.00', currency: 'EUR' },
              entry_reference: 'tx-1',
            },
          ],
          continuation_key: 'page-2-token',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          transactions: [
            {
              status: 'BOOK',
              booking_date: '2024-01-01',
              creditor: { name: 'Store 2' },
              transaction_amount: { amount: '-20.00', currency: 'EUR' },
              entry_reference: 'tx-2',
            },
          ],
          continuation_key: null,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          balances: [
            {
              balance_type: 'CLBD',
              balance_amount: { amount: '100.00', currency: 'EUR' },
            },
          ],
        }),
      });

    const res = await authenticatedPost('/transactions', {
      accountId: 'acc-1',
      startDate: '2024-01-01',
      endDate: '2024-01-31',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.transactions.all).toHaveLength(2);
    expect(res.body.data.continuation_key).toBeNull();

    const [secondTransactionsUrl] = global.fetch.mock.calls[1];
    expect(secondTransactionsUrl).toContain('continuation_key=page-2-token');
  });

  it('captures PSU headers from callback and forwards them to transactions API calls', async () => {
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          session_id: 'session-psu',
          aspsp: { name: 'Test Bank', country: 'LT' },
          accounts: [
            { uid: 'acc-1', identification_hash: 'hash-1', name: 'A' },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          transactions: [],
          continuation_key: null,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          balances: [],
        }),
      });

    await request(app)
      .get('/callback?state=state-psu&code=auth-code-psu')
      .set('User-Agent', 'EnableBankingTestUA')
      .set('Accept-Language', 'en-US')
      .set('Referer', 'https://enablebanking.com');

    await authenticatedPost('/poll-auth', { state: 'state-psu' });

    await authenticatedPost('/transactions', {
      accountId: 'acc-1',
      sessionId: 'session-psu',
      startDate: '2024-01-01',
    });

    const [, transactionsOptions] = global.fetch.mock.calls[1];
    expect(transactionsOptions.headers['Psu-User-Agent']).toBe(
      'EnableBankingTestUA',
    );
    expect(transactionsOptions.headers['Psu-Accept-language']).toBe('en-US');
    expect(transactionsOptions.headers['Psu-Referer']).toBe(
      'https://enablebanking.com',
    );
  });

  it('forwards continuation_key and returns continuation_key in /transactions', async () => {
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          transactions: [
            {
              status: 'BOOK',
              booking_date: '2024-01-02',
              creditor: { name: 'Store' },
              transaction_amount: { amount: '-10.00', currency: 'EUR' },
              entry_reference: 'tx-1',
            },
          ],
          continuation_key: 'next-page-token',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          balances: [
            {
              balance_type: 'CLBD',
              balance_amount: { amount: '100.00', currency: 'EUR' },
            },
          ],
        }),
      });

    const res = await authenticatedPost('/transactions', {
      accountId: 'acc-1',
      startDate: '2024-01-01',
      endDate: '2024-01-31',
      continuationKey: 'page-1-token',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.data.continuation_key).toBe('next-page-token');
    expect(res.body.data.transactions.all).toHaveLength(1);

    const [transactionsUrl] = global.fetch.mock.calls[0];
    expect(transactionsUrl).toContain('/accounts/acc-1/transactions');
    expect(transactionsUrl).toContain('continuation_key=page-1-token');
    expect(transactionsUrl).toContain('date_from=2024-01-01');
    expect(transactionsUrl).toContain('date_to=2024-01-31');
  });

  it('maps rate-limit errors to RATE_LIMIT_EXCEEDED', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({
        error: 'ASPSP_RATE_LIMIT_EXCEEDED',
        error_description: 'Too many requests',
      }),
    });

    const res = await authenticatedPost('/transactions', {
      accountId: 'acc-1',
      startDate: '2024-01-01',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({
      error_type: 'RATE_LIMIT_EXCEEDED',
      error_code: 'ENABLEBANKING_ERROR',
    });
  });

  it('maps auth-expired errors to ITEM_LOGIN_REQUIRED', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
      json: async () => ({
        error: 'EXPIRED_SESSION',
        error_description: 'Session is expired',
      }),
    });

    const res = await authenticatedPost('/transactions', {
      accountId: 'acc-1',
      startDate: '2024-01-01',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({
      error_type: 'ITEM_ERROR',
      error_code: 'ITEM_LOGIN_REQUIRED',
    });
  });

  it('maps bad-credentials errors to ITEM_LOGIN_REQUIRED', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({
        error: 'WRONG_CREDENTIALS_PROVIDED',
        error_description: 'Wrong credentials provided',
      }),
    });

    const res = await authenticatedPost('/transactions', {
      accountId: 'acc-1',
      startDate: '2024-01-01',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({
      error_type: 'ITEM_ERROR',
      error_code: 'ITEM_LOGIN_REQUIRED',
    });
  });
});
