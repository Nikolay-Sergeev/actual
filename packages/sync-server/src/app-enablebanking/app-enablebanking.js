import { randomUUID } from 'node:crypto';

import express from 'express';

import { handleError } from '../app-gocardless/util/handle-error';
import {
  requestLoggerMiddleware,
  validateSessionMiddleware,
} from '../util/middlewares';

const app = express();
export { app as handlers };

app.use(requestLoggerMiddleware);
app.use(express.json());

const ENABLE_BANKING_API_URL = 'https://api.enablebanking.com';
const AUTH_STATE_TTL_MS = 30 * 60 * 1000;

const pendingAuthById = new Map();
const authResultByState = new Map();

class EnableBankingApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'EnableBankingApiError';
    this.status = status;
    this.details = details;
  }
}

function cleanupAuthCache() {
  const now = Date.now();

  for (const [key, value] of pendingAuthById.entries()) {
    if (value.createdAt + AUTH_STATE_TTL_MS < now) {
      pendingAuthById.delete(key);
    }
  }

  for (const [key, value] of authResultByState.entries()) {
    if (value.updatedAt + AUTH_STATE_TTL_MS < now) {
      authResultByState.delete(key);
    }
  }
}

function getQueryString(query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value == null || value === '') {
      continue;
    }
    params.set(key, String(value));
  }
  const queryString = params.toString();
  return queryString === '' ? '' : `?${queryString}`;
}

async function enableBankingRequest({
  path,
  method = 'GET',
  jwt,
  query = null,
  body = null,
}) {
  if (!jwt || typeof jwt !== 'string') {
    throw new EnableBankingApiError('MISSING_JWT', 401);
  }

  const url = `${ENABLE_BANKING_API_URL}${path}${getQueryString(query)}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new EnableBankingApiError(
      data?.error || data?.message || 'ENABLE_BANKING_API_ERROR',
      response.status,
      data,
    );
  }

  return data;
}

function parseDecimalAmountToCents(amount) {
  const normalized = Number.parseFloat(String(amount ?? 0));
  if (!Number.isFinite(normalized)) {
    return 0;
  }
  return Math.round(normalized * 100);
}

function mapBalanceType(balanceType) {
  switch (balanceType) {
    case 'CLBD':
      return 'closingBooked';
    case 'XPCD':
      return 'expected';
    case 'FWAV':
      return 'forwardAvailable';
    case 'ITAV':
      return 'interimAvailable';
    case 'ITBD':
      return 'interimBooked';
    case 'OPBD':
      return 'openingBooked';
    default:
      return 'expected';
  }
}

function getStartingBalance(normalizedBalances) {
  const preferredBalance =
    normalizedBalances.find(
      balance =>
        balance.balanceType === 'closingBooked' ||
        balance.balanceType === 'interimAvailable' ||
        balance.balanceType === 'expected',
    ) ?? normalizedBalances[0];

  return parseDecimalAmountToCents(preferredBalance?.balanceAmount?.amount);
}

function normalizeBalances(balances) {
  return (balances ?? []).map(balance => ({
    balanceAmount: {
      amount: balance.balance_amount?.amount ?? '0',
      currency: balance.balance_amount?.currency ?? 'EUR',
    },
    balanceType: mapBalanceType(balance.balance_type),
    lastChangeDateTime: balance.last_change_date_time,
    lastCommittedTransaction: balance.last_committed_transaction,
    referenceDate: balance.reference_date,
  }));
}

function normalizeTransaction(transaction) {
  const date =
    transaction.booking_date ||
    transaction.value_date ||
    transaction.transaction_date;
  const remittance =
    transaction.remittance_information?.filter(Boolean).join('\n') || null;

  return {
    booked: transaction.status === 'BOOK',
    date,
    payeeName:
      transaction.creditor?.name || transaction.debtor?.name || 'Unknown',
    notes: remittance,
    transactionAmount: {
      amount: transaction.transaction_amount?.amount ?? '0',
      currency: transaction.transaction_amount?.currency ?? 'EUR',
    },
    transactionId: transaction.entry_reference || transaction.transaction_id,
    sortOrder: date ? new Date(date).getTime() : 0,
  };
}

function sortTransactions(transactions) {
  return [...transactions].sort((a, b) => b.sortOrder - a.sortOrder);
}

function normalizeTransactions(transactions) {
  const all = sortTransactions((transactions ?? []).map(normalizeTransaction));
  const booked = all.filter(transaction => transaction.booked);
  const pending = all.filter(transaction => !transaction.booked);
  return { all, booked, pending };
}

function accountDisplayName(account) {
  return (
    account.name ||
    account.details ||
    account.account_id?.iban ||
    account.account_id?.other?.identification ||
    `Account ${String(account.uid ?? '').slice(0, 8)}`
  );
}

function normalizeAccount({ account, aspsp, fallbackSessionAccount = null }) {
  return {
    account_id:
      account.uid ||
      account.identification_hash ||
      fallbackSessionAccount?.uid ||
      randomUUID(),
    identification_hash:
      account.identification_hash || fallbackSessionAccount?.identification_hash,
    institution: aspsp?.name ?? 'Unknown',
    orgDomain: aspsp?.country ?? null,
    orgId: aspsp?.name ?? 'Unknown',
    name: accountDisplayName(account),
    balance: 0,
    uid: account.uid || fallbackSessionAccount?.uid || null,
  };
}

function getAuthErrorData(error) {
  if (error instanceof EnableBankingApiError) {
    return {
      error_type: 'SYNC_ERROR',
      error_code: error.details?.error || String(error.status || 'UNKNOWN'),
      reason:
        error.details?.error_description ||
        error.details?.message ||
        error.message,
      details: error.details ?? null,
    };
  }

  return {
    error_type: 'UNKNOWN',
    error_code: 'UNKNOWN',
    reason: error?.message || 'Something went wrong',
  };
}

app.get('/callback', (req, res) => {
  cleanupAuthCache();

  const { state, code, error, error_description: errorDescription } =
    req.query ?? {};

  if (typeof state === 'string' && state.length > 0) {
    authResultByState.set(state, {
      code: typeof code === 'string' ? code : null,
      error: typeof error === 'string' ? error : null,
      errorDescription:
        typeof errorDescription === 'string' ? errorDescription : null,
      updatedAt: Date.now(),
    });
  }

  res.status(200).send('Authorization received. You can return to Actual.');
});

app.use(validateSessionMiddleware);

app.post('/status', async (_req, res) => {
  res.send({
    status: 'ok',
    data: {
      configured: Boolean(
        process.env.ENABLEBANKING_APPLICATION_ID &&
          process.env.ENABLEBANKING_PRIVATE_KEY,
      ),
    },
  });
});

const getAspsps = handleError(async (req, res) => {
  const {
    jwt,
    country = null,
    psuType = null,
    service = 'AIS',
    paymentType = null,
  } = req.body || {};

  const data = await enableBankingRequest({
    path: '/aspsps',
    method: 'GET',
    jwt,
    query: {
      country,
      psu_type: psuType,
      service,
      payment_type: paymentType,
    },
  });

  res.send({
    status: 'ok',
    data,
  });
});

app.post('/aspsps', getAspsps);
app.post('/banks', getAspsps);

app.post(
  '/create-auth',
  handleError(async (req, res) => {
    cleanupAuthCache();

    const {
      jwt,
      aspsp,
      access,
      redirectUrl,
      state = randomUUID(),
      psuType,
      authMethod,
      credentials,
      credentialsAutosubmit,
      language,
      psuId,
    } = req.body || {};

    const data = await enableBankingRequest({
      path: '/auth',
      method: 'POST',
      jwt,
      body: {
        aspsp,
        access,
        redirect_url: redirectUrl,
        state,
        ...(psuType ? { psu_type: psuType } : {}),
        ...(authMethod ? { auth_method: authMethod } : {}),
        ...(credentials ? { credentials } : {}),
        ...(credentialsAutosubmit !== undefined
          ? { credentials_autosubmit: credentialsAutosubmit }
          : {}),
        ...(language ? { language } : {}),
        ...(psuId ? { psu_id: psuId } : {}),
      },
    });

    if (data.authorization_id) {
      pendingAuthById.set(data.authorization_id, {
        state,
        createdAt: Date.now(),
      });
    }

    res.send({
      status: 'ok',
      data: {
        ...data,
        state,
      },
    });
  }),
);

app.post(
  '/poll-auth',
  handleError(async (req, res) => {
    cleanupAuthCache();

    const { jwt, authorizationId, state } = req.body || {};
    const pending = authorizationId ? pendingAuthById.get(authorizationId) : {};
    const authState = state || pending?.state;

    if (!authState) {
      res.send({
        status: 'ok',
        data: {
          status: 'error',
          error: 'WRONG_REQUEST_PARAMETERS',
          error_description: 'Missing state and authorizationId',
        },
      });
      return;
    }

    const callbackResult = authResultByState.get(authState);
    if (!callbackResult) {
      res.send({
        status: 'ok',
        data: {
          status: 'pending',
        },
      });
      return;
    }

    if (callbackResult.error) {
      res.send({
        status: 'ok',
        data: {
          status: 'error',
          error: callbackResult.error,
          error_description: callbackResult.errorDescription,
        },
      });
      return;
    }

    const session = await enableBankingRequest({
      path: '/sessions',
      method: 'POST',
      jwt,
      body: {
        code: callbackResult.code,
      },
    });

    if (authorizationId) {
      pendingAuthById.delete(authorizationId);
    }
    authResultByState.delete(authState);

    res.send({
      status: 'ok',
      data: {
        status: 'authorized',
        ...session,
        accounts: (session.accounts ?? []).map(account =>
          normalizeAccount({
            account,
            aspsp: session.aspsp,
          }),
        ),
      },
    });
  }),
);

app.post(
  '/accounts',
  handleError(async (req, res) => {
    const { jwt, sessionId } = req.body || {};

    const session = await enableBankingRequest({
      path: `/sessions/${sessionId}`,
      method: 'GET',
      jwt,
    });

    const accountIds =
      session.accounts ??
      session.accounts_data?.map(account => account.uid).filter(Boolean) ??
      [];

    const detailedAccounts = await Promise.all(
      accountIds.map(async accountId => {
        try {
          return await enableBankingRequest({
            path: `/accounts/${accountId}/details`,
            method: 'GET',
            jwt,
          });
        } catch {
          return null;
        }
      }),
    );

    const accounts = accountIds.map((accountId, index) =>
      normalizeAccount({
        account: detailedAccounts[index] ?? { uid: accountId },
        aspsp: session.aspsp,
        fallbackSessionAccount: session.accounts_data?.find(
          account => account.uid === accountId,
        ),
      }),
    );

    res.send({
      status: 'ok',
      data: {
        session_id: sessionId,
        accounts,
      },
    });
  }),
);

app.post('/transactions', async (req, res) => {
  const {
    jwt,
    accountId,
    startDate,
    endDate,
    continuationKey,
    transactionStatus,
    strategy,
    includeBalance = true,
  } = req.body || {};

  try {
    const transactionsResponse = await enableBankingRequest({
      path: `/accounts/${accountId}/transactions`,
      method: 'GET',
      jwt,
      query: {
        date_from: startDate,
        date_to: endDate,
        continuation_key: continuationKey,
        transaction_status: transactionStatus,
        strategy,
      },
    });

    let normalizedBalances = [];
    if (includeBalance) {
      const balancesResponse = await enableBankingRequest({
        path: `/accounts/${accountId}/balances`,
        method: 'GET',
        jwt,
      });
      normalizedBalances = normalizeBalances(balancesResponse.balances);
    }

    const normalizedTransactions = normalizeTransactions(
      transactionsResponse.transactions,
    );

    res.send({
      status: 'ok',
      data: {
        balances: normalizedBalances,
        startingBalance: getStartingBalance(normalizedBalances),
        transactions: normalizedTransactions,
        continuation_key: transactionsResponse.continuation_key ?? null,
      },
    });
  } catch (error) {
    res.send({
      status: 'ok',
      data: getAuthErrorData(error),
    });
  }
});

app.post(
  '/remove-account',
  handleError(async (req, res) => {
    const { jwt, sessionId } = req.body || {};

    const data = await enableBankingRequest({
      path: `/sessions/${sessionId}`,
      method: 'DELETE',
      jwt,
    });

    res.send({
      status: 'ok',
      data,
    });
  }),
);
