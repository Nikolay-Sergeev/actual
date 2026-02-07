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

  it('stores callback code and authorizes on poll-auth by state', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        session_id: 'session-123',
        aspsp: { name: 'Test Bank', country: 'LT' },
        accounts: [{ uid: 'acc-1', identification_hash: 'hash-1', name: 'A' }],
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
