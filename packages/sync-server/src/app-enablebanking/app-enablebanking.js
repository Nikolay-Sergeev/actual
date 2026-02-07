import { randomUUID } from 'node:crypto';

import express from 'express';
import jws from 'jws';

import { getAccountDb } from '../account-db';
import { handleError } from '../app-gocardless/util/handle-error';
import { SecretName, secretsService } from '../services/secrets-service';
import {
  requestLoggerMiddleware,
  validateSessionMiddleware,
} from '../util/middlewares';

const app = express();
export { app as handlers };

app.use(requestLoggerMiddleware);
app.use(express.json());

const ENABLE_BANKING_API_URL = 'https://api.enablebanking.com';
const ENABLE_BANKING_ISSUER = 'enablebanking.com';
const ENABLE_BANKING_AUDIENCE = 'api.enablebanking.com';
const MAX_JWT_TTL_SECONDS = 24 * 60 * 60;
const AUTH_STATE_TTL_MS = 30 * 60 * 1000;
const SESSION_PSU_HEADERS_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CONSENT_VALIDITY_SECONDS = 24 * 60 * 60;
const AUTO_PAGINATION_MAX_PAGES = 20;
const ENABLE_BANKING_ENVIRONMENTS = new Set(['SANDBOX', 'PRODUCTION']);
const TEMP_PENDING_AUTH_PREFIX = 'enablebanking_tmp_pending_auth:';
const TEMP_AUTH_RESULT_PREFIX = 'enablebanking_tmp_auth_result:';
const TEMP_SESSION_PSU_HEADERS_PREFIX = 'enablebanking_tmp_session_psu:';

class EnableBankingApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'EnableBankingApiError';
    this.status = status;
    this.details = details;
  }
}

function getEnableBankingConfig() {
  const applicationId = secretsService.get(
    SecretName.enablebanking_applicationId,
  );
  const privateKey = secretsService.get(SecretName.enablebanking_privateKey);
  const redirectUrl = secretsService.get(SecretName.enablebanking_redirectUrl);
  const environment = (
    secretsService.get(SecretName.enablebanking_environment) || 'SANDBOX'
  ).toUpperCase();

  return {
    applicationId,
    privateKey,
    redirectUrl:
      typeof redirectUrl === 'string' && redirectUrl.trim() !== ''
        ? redirectUrl.trim()
        : null,
    environment,
  };
}

function isEnableBankingConfigured() {
  const { applicationId, privateKey, environment } = getEnableBankingConfig();

  return Boolean(
    applicationId && privateKey && ENABLE_BANKING_ENVIRONMENTS.has(environment),
  );
}

function normalizePrivateKey(privateKey) {
  if (!privateKey) {
    return privateKey;
  }

  let normalized = privateKey.trim();
  if (normalized.includes('\\n')) {
    normalized = normalized.replaceAll('\\n', '\n');
  }
  normalized = normalized.replace(/\r\n?/g, '\n');

  // Support keys pasted into single-line inputs where line breaks are lost.
  if (!normalized.includes('\n')) {
    const pemMatch = normalized.match(
      /^-----BEGIN ([A-Z ]+)-----([A-Za-z0-9+/=\s]+)-----END \1-----$/,
    );
    if (pemMatch) {
      const [, label, body] = pemMatch;
      const compactBody = body.replace(/\s+/g, '');
      const wrappedBody =
        compactBody.match(/.{1,64}/g)?.join('\n') ?? compactBody;

      normalized = `-----BEGIN ${label}-----\n${wrappedBody}\n-----END ${label}-----`;
    }
  }

  return normalized;
}

function createEnableBankingJwt() {
  const { applicationId, privateKey, environment } = getEnableBankingConfig();

  if (!applicationId || !privateKey) {
    throw new EnableBankingApiError('ENABLE_BANKING_NOT_CONFIGURED', 401, {
      error: 'ENABLE_BANKING_NOT_CONFIGURED',
      message: 'Application ID and private key are required',
    });
  }

  if (!ENABLE_BANKING_ENVIRONMENTS.has(environment)) {
    throw new EnableBankingApiError('ENABLE_BANKING_NOT_CONFIGURED', 401, {
      error: 'ENABLE_BANKING_NOT_CONFIGURED',
      message: 'Environment must be SANDBOX or PRODUCTION',
    });
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const expirationTime = issuedAt + Math.min(MAX_JWT_TTL_SECONDS, 60 * 60);

  return jws.sign({
    header: {
      typ: 'JWT',
      alg: 'RS256',
      kid: applicationId,
    },
    payload: {
      iss: ENABLE_BANKING_ISSUER,
      aud: ENABLE_BANKING_AUDIENCE,
      iat: issuedAt,
      exp: expirationTime,
    },
    privateKey: normalizePrivateKey(privateKey),
  });
}

function getTemporaryEntry(prefix, key) {
  if (!key) {
    return null;
  }

  const row = getAccountDb().first('SELECT value FROM secrets WHERE name = ?', [
    `${prefix}${key}`,
  ]);

  if (!row?.value) {
    return null;
  }

  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

function getTemporaryEntries(prefix) {
  const rows = getAccountDb().all(
    'SELECT name, value FROM secrets WHERE name LIKE ?',
    [`${prefix}%`],
  );

  const entries = [];
  for (const row of rows) {
    try {
      entries.push({
        key: String(row.name).slice(prefix.length),
        value: JSON.parse(row.value),
      });
    } catch {
      // Ignore malformed temporary rows.
    }
  }
  return entries;
}

function setTemporaryEntry(prefix, key, value) {
  if (!key) {
    return;
  }

  getAccountDb().mutate(
    'INSERT OR REPLACE INTO secrets (name, value) VALUES (?, ?)',
    [`${prefix}${key}`, JSON.stringify(value)],
  );
}

function deleteTemporaryEntry(prefix, key) {
  if (!key) {
    return;
  }

  getAccountDb().mutate('DELETE FROM secrets WHERE name = ?', [
    `${prefix}${key}`,
  ]);
}

function cleanupTemporaryEntries(prefix, ttlMs) {
  const now = Date.now();
  const rows = getAccountDb().all(
    'SELECT name, value FROM secrets WHERE name LIKE ?',
    [`${prefix}%`],
  );

  for (const row of rows) {
    let updatedAt = null;
    try {
      const parsed = JSON.parse(row.value);
      updatedAt = Number(parsed?.updatedAt ?? parsed?.createdAt ?? null);
    } catch {
      updatedAt = null;
    }

    if (!Number.isFinite(updatedAt) || updatedAt + ttlMs < now) {
      getAccountDb().mutate('DELETE FROM secrets WHERE name = ?', [row.name]);
    }
  }
}

function cleanupAuthCache() {
  cleanupTemporaryEntries(TEMP_PENDING_AUTH_PREFIX, AUTH_STATE_TTL_MS);
  cleanupTemporaryEntries(TEMP_AUTH_RESULT_PREFIX, AUTH_STATE_TTL_MS);
  cleanupTemporaryEntries(
    TEMP_SESSION_PSU_HEADERS_PREFIX,
    SESSION_PSU_HEADERS_TTL_MS,
  );
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
  query = null,
  body = null,
  headers = null,
}) {
  const jwt = createEnableBankingJwt();

  const url = `${ENABLE_BANKING_API_URL}${path}${getQueryString(query)}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(headers ?? {}),
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
  const uid = account.uid || fallbackSessionAccount?.uid || null;

  return {
    account_id: uid,
    identification_hash:
      account.identification_hash ||
      fallbackSessionAccount?.identification_hash,
    institution: aspsp?.name ?? 'Unknown',
    orgDomain: aspsp?.country ?? null,
    orgId: aspsp?.name ?? 'Unknown',
    name: accountDisplayName(account),
    balance: 0,
    uid,
  };
}

function getSessionAccountIds(session) {
  const accountIdsFromAccounts =
    session.accounts
      ?.map(account =>
        typeof account === 'string' ? account : (account?.uid ?? null),
      )
      .filter(Boolean) ?? [];

  if (accountIdsFromAccounts.length > 0) {
    return accountIdsFromAccounts;
  }

  return (
    session.accounts_data?.map(account => account?.uid).filter(Boolean) ?? []
  );
}

async function getNormalizedSessionAccounts({
  sessionId,
  session = null,
  psuHeaders = null,
}) {
  const activeSession =
    session ??
    (await enableBankingRequest({
      path: `/sessions/${sessionId}`,
      method: 'GET',
    }));

  const accountIds = getSessionAccountIds(activeSession);
  if (accountIds.length === 0) {
    return { session: activeSession, accounts: [] };
  }

  const detailedAccounts = await Promise.all(
    accountIds.map(async accountId => {
      try {
        return await enableBankingRequest({
          path: `/accounts/${accountId}/details`,
          method: 'GET',
          headers: psuHeaders,
        });
      } catch {
        return null;
      }
    }),
  );

  const accounts = accountIds
    .map((accountId, index) =>
      normalizeAccount({
        account: detailedAccounts[index] ?? { uid: accountId },
        aspsp: activeSession.aspsp,
        fallbackSessionAccount: activeSession.accounts_data?.find(
          account => account.uid === accountId,
        ),
      }),
    )
    .filter(account => Boolean(account.account_id));

  return { session: activeSession, accounts };
}

function getHeaderValue(req, headerName) {
  const value = req.get(headerName);
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function getPsuHeadersFromRequest(req) {
  const forwardedFor = getHeaderValue(req, 'x-forwarded-for');
  const ipAddress =
    forwardedFor?.split(',')[0]?.trim() || req.ip || req.socket?.remoteAddress;
  const userAgent = getHeaderValue(req, 'user-agent');
  const referer = getHeaderValue(req, 'referer');
  const accept = getHeaderValue(req, 'accept');
  const acceptCharset = getHeaderValue(req, 'accept-charset');
  const acceptEncoding = getHeaderValue(req, 'accept-encoding');
  const acceptLanguage = getHeaderValue(req, 'accept-language');

  const psuHeaders = {
    ...(ipAddress ? { 'Psu-Ip-Address': ipAddress } : {}),
    ...(userAgent ? { 'Psu-User-Agent': userAgent } : {}),
    ...(referer ? { 'Psu-Referer': referer } : {}),
    ...(accept ? { 'Psu-Accept': accept } : {}),
    ...(acceptCharset ? { 'Psu-Accept-Charset': acceptCharset } : {}),
    ...(acceptEncoding ? { 'Psu-Accept-Encoding': acceptEncoding } : {}),
    ...(acceptLanguage ? { 'Psu-Accept-language': acceptLanguage } : {}),
  };

  return Object.keys(psuHeaders).length > 0 ? psuHeaders : null;
}

function getPublicOrigin(req) {
  const forwardedProto = getHeaderValue(req, 'x-forwarded-proto');
  const forwardedHost = getHeaderValue(req, 'x-forwarded-host');
  const host = (forwardedHost || getHeaderValue(req, 'host') || '')
    .split(',')[0]
    .trim();
  const proto = (forwardedProto || req.protocol || 'http').split(',')[0].trim();

  if (!host) {
    return null;
  }

  return `${proto}://${host}`;
}

function getDefaultRedirectUrl(req) {
  const origin = getPublicOrigin(req);
  if (!origin) {
    return null;
  }

  return `${origin}/enablebanking/callback`;
}

function validateRedirectUrl(redirectUrl) {
  try {
    // Throws if malformed
    new URL(redirectUrl);
  } catch {
    throw new EnableBankingApiError('WRONG_REQUEST_PARAMETERS', 400, {
      error: 'WRONG_REQUEST_PARAMETERS',
      message: 'Invalid redirect URL',
    });
  }
}

function getSessionPsuHeaders(sessionId) {
  if (!sessionId) {
    return null;
  }

  const data = getTemporaryEntry(TEMP_SESSION_PSU_HEADERS_PREFIX, sessionId);
  if (!data) {
    return null;
  }

  setTemporaryEntry(TEMP_SESSION_PSU_HEADERS_PREFIX, sessionId, {
    ...data,
    updatedAt: Date.now(),
  });
  return data.headers;
}

function findAspsp(aspsps, expectedAspsp) {
  const expectedName = String(expectedAspsp?.name ?? '')
    .trim()
    .toLowerCase();
  const expectedCountry = String(expectedAspsp?.country ?? '')
    .trim()
    .toUpperCase();

  return aspsps.find(aspsp => {
    const aspspName = String(aspsp?.name ?? '')
      .trim()
      .toLowerCase();
    const aspspCountry = String(aspsp?.country ?? '')
      .trim()
      .toUpperCase();
    return aspspName === expectedName && aspspCountry === expectedCountry;
  });
}

function capValidUntil(validUntil, maximumConsentValidity) {
  const now = Date.now();
  const nowSeconds = Math.floor(now / 1000);

  const parsedValidUntilMs = Date.parse(String(validUntil ?? ''));
  const requestedMs = Number.isFinite(parsedValidUntilMs)
    ? parsedValidUntilMs
    : now + DEFAULT_CONSENT_VALIDITY_SECONDS * 1000;

  const maxValiditySeconds = Number.parseInt(
    String(maximumConsentValidity ?? ''),
    10,
  );
  const hasValidityLimit =
    Number.isFinite(maxValiditySeconds) && maxValiditySeconds > 0;

  let cappedMs = Math.max(requestedMs, nowSeconds * 1000);
  if (hasValidityLimit) {
    const maxAllowedMs = now + maxValiditySeconds * 1000;
    cappedMs = Math.min(cappedMs, maxAllowedMs);
  }
  return new Date(cappedMs).toISOString();
}

async function getNormalizedAccess({ aspsp, access, psuType }) {
  const normalizedAccess = {
    ...(access ?? {}),
  };

  let maximumConsentValidity = null;

  if (aspsp?.country && aspsp?.name) {
    try {
      const aspspsResponse = await enableBankingRequest({
        path: '/aspsps',
        method: 'GET',
        query: {
          country: aspsp.country,
          service: 'AIS',
          psu_type: psuType,
        },
      });

      const matchedAspsp = findAspsp(aspspsResponse?.aspsps ?? [], aspsp);
      maximumConsentValidity = matchedAspsp?.maximum_consent_validity ?? null;
    } catch {
      maximumConsentValidity = null;
    }
  }

  normalizedAccess.valid_until = capValidUntil(
    normalizedAccess.valid_until,
    maximumConsentValidity,
  );

  return normalizedAccess;
}

const ENABLE_BANKING_AUTH_EXPIRED_ERRORS = new Set([
  'EXPIRED_SESSION',
  'REVOKED_SESSION',
  'SESSION_DOES_NOT_EXIST',
  'WRONG_SESSION_STATUS',
  'EXPIRED_AUTHORIZATION_CODE',
  'WRONG_AUTHORIZATION_CODE',
  'ALREADY_AUTHORIZED',
  'CLOSED_SESSION',
]);

const ENABLE_BANKING_BAD_CREDENTIAL_ERRORS = new Set([
  'WRONG_CREDENTIALS_PROVIDED',
  'ACCESS_DENIED',
  'AUTHORIZATION_NOT_PROVIDED',
  'UNAUTHORIZED_ACCESS',
]);
const ENABLE_BANKING_PENDING_SESSION_STATUSES = new Set([
  'PENDING_AUTHORIZATION',
  'RETURNED_FROM_BANK',
]);

function getEnableBankingErrorCode(error) {
  return String(error?.details?.error || '').toUpperCase();
}

function mapEnableBankingSyncError(error) {
  if (error instanceof EnableBankingApiError) {
    const providerErrorCode = getEnableBankingErrorCode(error);
    const reason =
      error.details?.error_description ||
      error.details?.message ||
      error.message;

    if (
      providerErrorCode === 'ASPSP_RATE_LIMIT_EXCEEDED' ||
      error.status === 429
    ) {
      return {
        error_type: 'RATE_LIMIT_EXCEEDED',
        error_code: 'ENABLEBANKING_ERROR',
        status: 'rejected',
        reason,
        details: error.details ?? null,
      };
    }

    if (providerErrorCode === 'ASPSP_TIMEOUT' || error.status === 408) {
      return {
        error_type: 'TIMED_OUT',
        error_code: 'TIMED_OUT',
        status: 'rejected',
        reason,
        details: error.details ?? null,
      };
    }

    if (
      ENABLE_BANKING_AUTH_EXPIRED_ERRORS.has(providerErrorCode) ||
      ENABLE_BANKING_BAD_CREDENTIAL_ERRORS.has(providerErrorCode) ||
      providerErrorCode === 'PSU_HEADER_NOT_PROVIDED'
    ) {
      return {
        error_type: 'ITEM_ERROR',
        error_code: 'ITEM_LOGIN_REQUIRED',
        status: 'expired',
        reason,
        details: error.details ?? null,
      };
    }

    return {
      error_type: 'SYNC_ERROR',
      error_code: providerErrorCode || String(error.status || 'UNKNOWN'),
      reason,
      details: error.details ?? null,
    };
  }

  return {
    error_type: 'UNKNOWN',
    error_code: 'UNKNOWN',
    reason: error?.message || 'Something went wrong',
  };
}

function findCallbackResultForPendingAuth({
  authState,
  authorizationId,
  pending,
}) {
  const directMatch = getTemporaryEntry(TEMP_AUTH_RESULT_PREFIX, authState);
  if (directMatch) {
    return { state: authState, result: directMatch };
  }

  if (!authorizationId || !pending || pending.sessionId) {
    return null;
  }

  const createdAt = Number(pending.createdAt ?? 0);
  if (!Number.isFinite(createdAt) || createdAt <= 0) {
    return null;
  }

  const candidates = getTemporaryEntries(TEMP_AUTH_RESULT_PREFIX).filter(
    entry => {
      const updatedAt = Number(entry.value?.updatedAt ?? 0);
      return (
        Number.isFinite(updatedAt) &&
        updatedAt >= createdAt &&
        (entry.value?.code || entry.value?.error)
      );
    },
  );

  // If there is exactly one callback newer than this auth request, use it.
  if (candidates.length === 1) {
    return { state: candidates[0].key, result: candidates[0].value };
  }

  return null;
}

app.get('/callback', (req, res) => {
  cleanupAuthCache();

  const {
    state,
    code,
    error,
    error_description: errorDescription,
  } = req.query ?? {};
  const psuHeaders = getPsuHeadersFromRequest(req);

  if (typeof state === 'string' && state.length > 0) {
    setTemporaryEntry(TEMP_AUTH_RESULT_PREFIX, state, {
      code: typeof code === 'string' ? code : null,
      error: typeof error === 'string' ? error : null,
      errorDescription:
        typeof errorDescription === 'string' ? errorDescription : null,
      psuHeaders,
      updatedAt: Date.now(),
    });
  }

  res.status(200).send('Authorization received. You can return to Actual.');
});

app.use(validateSessionMiddleware);

app.post('/status', async (_req, res) => {
  const { environment, redirectUrl } = getEnableBankingConfig();
  const callbackUrl = redirectUrl || getDefaultRedirectUrl(_req);

  res.send({
    status: 'ok',
    data: {
      configured: isEnableBankingConfigured(),
      environment,
      callback_url: callbackUrl,
    },
  });
});

const getAspsps = handleError(async (req, res) => {
  const {
    country = null,
    psuType = null,
    service = 'AIS',
    paymentType = null,
  } = req.body || {};

  const data = await enableBankingRequest({
    path: '/aspsps',
    method: 'GET',
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
    // Capture PSU headers early so we can forward them to /auth and also
    // fall back to them in /poll-auth in case the callback request doesn't
    // include these headers (proxy setups, strict browser policies, etc).
    const initialPsuHeaders = getPsuHeadersFromRequest(req);
    const { redirectUrl: configuredRedirectUrl } = getEnableBankingConfig();
    // Prefer explicitly configured callback URL (public/reverse-proxied setups),
    // then caller-provided URL, then request-derived fallback.
    const callbackUrl =
      configuredRedirectUrl || redirectUrl || getDefaultRedirectUrl(req);

    if (!callbackUrl) {
      throw new EnableBankingApiError('WRONG_REQUEST_PARAMETERS', 400, {
        error: 'WRONG_REQUEST_PARAMETERS',
        message:
          'Missing redirect URL. Set enablebanking_redirectUrl secret or send requests with a valid Host header.',
      });
    }

    validateRedirectUrl(callbackUrl);
    const normalizedAccess = await getNormalizedAccess({
      aspsp,
      access,
      psuType,
    });

    let data;
    try {
      data = await enableBankingRequest({
        path: '/auth',
        method: 'POST',
        headers: initialPsuHeaders,
        body: {
          aspsp,
          access: normalizedAccess,
          redirect_url: callbackUrl,
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
    } catch (error) {
      if (
        error instanceof EnableBankingApiError &&
        getEnableBankingErrorCode(error) === 'REDIRECT_URI_NOT_ALLOWED'
      ) {
        res.send({
          status: 'ok',
          data: {
            error_code: 'REDIRECT_URI_NOT_ALLOWED',
            error_description: `Redirect URL is not allowed for this app: ${callbackUrl}`,
            redirect_url: callbackUrl,
          },
        });
        return;
      }
      throw error;
    }

    if (data.authorization_id) {
      setTemporaryEntry(TEMP_PENDING_AUTH_PREFIX, data.authorization_id, {
        state,
        psuHeaders: initialPsuHeaders,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    res.send({
      status: 'ok',
      data: {
        ...data,
        redirect_url: callbackUrl,
        state,
      },
    });
  }),
);

app.post(
  '/poll-auth',
  handleError(async (req, res) => {
    cleanupAuthCache();

    const { authorizationId, state } = req.body || {};
    const pending = authorizationId
      ? getTemporaryEntry(TEMP_PENDING_AUTH_PREFIX, authorizationId)
      : null;
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

    if (pending?.sessionId) {
      setTemporaryEntry(TEMP_PENDING_AUTH_PREFIX, authorizationId, {
        ...pending,
        updatedAt: Date.now(),
      });

      const { session: activeSession, accounts: normalizedAccounts } =
        await getNormalizedSessionAccounts({
          sessionId: pending.sessionId,
          psuHeaders:
            pending.psuHeaders || getSessionPsuHeaders(pending.sessionId),
        });

      if (normalizedAccounts.length > 0) {
        deleteTemporaryEntry(TEMP_PENDING_AUTH_PREFIX, authorizationId);

        res.send({
          status: 'ok',
          data: {
            status: 'authorized',
            ...activeSession,
            accounts: normalizedAccounts,
          },
        });
        return;
      }

      if (ENABLE_BANKING_PENDING_SESSION_STATUSES.has(activeSession.status)) {
        res.send({
          status: 'ok',
          data: {
            status: 'pending',
            session_id: pending.sessionId,
          },
        });
        return;
      }

      deleteTemporaryEntry(TEMP_PENDING_AUTH_PREFIX, authorizationId);

      res.send({
        status: 'ok',
        data: {
          status: 'error',
          error: 'NO_ACCOUNTS_ADDED',
          error_description:
            'Authorization completed but no accounts were shared by the bank. Please retry and make sure at least one account is selected in the bank consent flow.',
          session_id: pending.sessionId,
          session_status: activeSession.status,
        },
      });
      return;
    }

    const callbackStateAndResult = findCallbackResultForPendingAuth({
      authState,
      authorizationId,
      pending,
    });

    if (!callbackStateAndResult) {
      res.send({
        status: 'ok',
        data: {
          status: 'pending',
        },
      });
      return;
    }
    const { state: callbackState, result: callbackResult } =
      callbackStateAndResult;

    if (callbackResult.error) {
      if (authorizationId) {
        deleteTemporaryEntry(TEMP_PENDING_AUTH_PREFIX, authorizationId);
      }
      deleteTemporaryEntry(TEMP_AUTH_RESULT_PREFIX, callbackState);

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

    const psuHeaders = callbackResult.psuHeaders || pending?.psuHeaders || null;
    const session = await enableBankingRequest({
      path: '/sessions',
      method: 'POST',
      headers: psuHeaders,
      body: {
        code: callbackResult.code,
      },
    });

    if (session.session_id && psuHeaders) {
      setTemporaryEntry(TEMP_SESSION_PSU_HEADERS_PREFIX, session.session_id, {
        headers: psuHeaders,
        updatedAt: Date.now(),
      });
    }
    deleteTemporaryEntry(TEMP_AUTH_RESULT_PREFIX, callbackState);

    if (authorizationId) {
      setTemporaryEntry(TEMP_PENDING_AUTH_PREFIX, authorizationId, {
        ...(pending ?? {}),
        state: callbackState,
        sessionId: session.session_id,
        psuHeaders,
        createdAt: Number(pending?.createdAt ?? Date.now()),
        updatedAt: Date.now(),
      });
    }

    const { accounts: normalizedAccounts } = await getNormalizedSessionAccounts(
      {
        sessionId: session.session_id,
        session,
        psuHeaders,
      },
    );

    if (normalizedAccounts.length === 0) {
      if (ENABLE_BANKING_PENDING_SESSION_STATUSES.has(session.status)) {
        res.send({
          status: 'ok',
          data: {
            status: 'pending',
            session_id: session.session_id,
          },
        });
        return;
      }

      if (authorizationId) {
        deleteTemporaryEntry(TEMP_PENDING_AUTH_PREFIX, authorizationId);
      }

      res.send({
        status: 'ok',
        data: {
          status: 'error',
          error: 'NO_ACCOUNTS_ADDED',
          error_description:
            'Authorization completed but no accounts were shared by the bank. Please retry and make sure at least one account is selected in the bank consent flow.',
          session_id: session.session_id,
        },
      });
      return;
    }

    res.send({
      status: 'ok',
      data: {
        status: 'authorized',
        ...session,
        accounts: normalizedAccounts,
      },
    });

    if (authorizationId) {
      deleteTemporaryEntry(TEMP_PENDING_AUTH_PREFIX, authorizationId);
    }
  }),
);

app.post(
  '/accounts',
  handleError(async (req, res) => {
    const { sessionId } = req.body || {};
    const psuHeaders = getSessionPsuHeaders(sessionId);
    const { accounts } = await getNormalizedSessionAccounts({
      sessionId,
      psuHeaders,
    });

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
    accountId,
    sessionId,
    startDate,
    endDate,
    continuationKey,
    transactionStatus,
    strategy,
    includeBalance = true,
  } = req.body || {};

  try {
    const psuHeaders = getSessionPsuHeaders(sessionId);
    const shouldAutopaginate = !continuationKey;
    let nextContinuationKey = continuationKey || null;
    let responseContinuationKey = null;
    const transactions = [];
    let remainingPages = shouldAutopaginate ? AUTO_PAGINATION_MAX_PAGES : 1;

    while (remainingPages > 0) {
      const transactionsResponse = await enableBankingRequest({
        path: `/accounts/${accountId}/transactions`,
        method: 'GET',
        query: {
          date_from: startDate,
          date_to: endDate,
          continuation_key: nextContinuationKey,
          transaction_status: transactionStatus,
          strategy,
        },
        headers: psuHeaders,
      });

      transactions.push(...(transactionsResponse.transactions ?? []));
      responseContinuationKey = transactionsResponse.continuation_key ?? null;
      remainingPages -= 1;

      if (!shouldAutopaginate || !responseContinuationKey) {
        break;
      }
      nextContinuationKey = responseContinuationKey;
    }

    let normalizedBalances = [];
    if (includeBalance) {
      const balancesResponse = await enableBankingRequest({
        path: `/accounts/${accountId}/balances`,
        method: 'GET',
        headers: psuHeaders,
      });
      normalizedBalances = normalizeBalances(balancesResponse.balances);
    }

    const normalizedTransactions = normalizeTransactions(transactions);

    res.send({
      status: 'ok',
      data: {
        balances: normalizedBalances,
        startingBalance: getStartingBalance(normalizedBalances),
        transactions: normalizedTransactions,
        continuation_key: responseContinuationKey ?? null,
      },
    });
  } catch (error) {
    res.send({
      status: 'ok',
      data: mapEnableBankingSyncError(error),
    });
  }
});

app.post(
  '/remove-account',
  handleError(async (req, res) => {
    const { sessionId } = req.body || {};
    const psuHeaders = getSessionPsuHeaders(sessionId);

    const data = await enableBankingRequest({
      path: `/sessions/${sessionId}`,
      method: 'DELETE',
      headers: psuHeaders,
    });

    res.send({
      status: 'ok',
      data,
    });
  }),
);
