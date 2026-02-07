# Enable Banking API Reference (Integration Notes)

Source: `https://enablebanking.com`  
API base: `https://api.enablebanking.com`  
Deprecated base: `https://api.tilisy.com`

## Account Information (AIS) Flow

1. `GET /aspsps` to list available ASPSPs (banks).
2. User selects ASPSP.
3. App calls `POST /auth` with ASPSP, access scope, `redirect_url`, and `state`.
4. API returns redirect `url`.
5. User is redirected to Enable Banking page and completes consent/auth.
6. User is redirected back to callback URL with query params.
7. App reads `code` from callback and calls `POST /sessions`.
8. API returns `session_id` and accessible accounts.
9. App fetches balances and transactions using session-linked account IDs.

Callback query params:

- `code`
- `state`
- `error`
- `error_description`

## Payment Initiation (PIS) Flow

1. `GET /aspsps` to list banks.
2. User selects ASPSP.
3. App calls `POST /payments`.
4. API returns payment id + redirect URL.
5. User authorizes payment.
6. User is redirected back with `state` and optional error fields.
7. App checks payment state via `GET /payments/{payment_id}`.

## Authentication

Enable Banking requires JWT signed with app private RSA key.

### Setup

1. Generate RSA private key + self-signed certificate.
2. Register app and upload certificate.
3. Obtain application id (`kid`).
4. Sign JWT (RS256) and send in `Authorization` header.

### JWT Requirements

Header:

- `typ: "JWT"`
- `alg: "RS256"`
- `kid: "<application_id>"`

Payload:

- `iss: "enablebanking.com"`
- `aud: "api.enablebanking.com"`
- `iat: <unix timestamp>`
- `exp: <unix timestamp>`

Rule:

- `exp - iat <= 86400` (24h max TTL).

## Endpoints

### Sessions / Authorization

- `POST /auth` start authorization (returns redirect URL).
- `POST /sessions` exchange auth code for session.
- `GET /sessions/{session_id}` get session data.
- `DELETE /sessions/{session_id}` close session.

### Accounts

- `GET /accounts/{account_id}/details`
- `GET /accounts/{account_id}/balances`
- `GET /accounts/{account_id}/transactions`
- `GET /accounts/{account_id}/transactions/{transaction_id}`

### Payments

- `POST /payments`
- `GET /payments/{payment_id}`
- `DELETE /payments/{payment_id}`
- `GET /payments/{payment_id}/transactions/{transaction_id}`

### Misc

- `GET /aspsps`
- `GET /application`

## Important Schemas (AIS-focused)

### `StartAuthorizationRequest`

Key fields:

- `access` (`balances`, `transactions`, `valid_until`)
- `aspsp` (`name`, `country`)
- `state`
- `redirect_url`
- optional: `psu_type`, `auth_method`, `credentials`, `language`, `psu_id`

### `StartAuthorizationResponse`

Key fields:

- `url`
- `authorization_id`
- `psu_id_hash`

### `AuthorizeSessionResponse`

Key fields:

- `session_id`
- `accounts`
- `aspsp`
- `psu_type`
- `access`

### Account identity fields

Important for mapping/relink:

- `uid` (session-scoped account identifier)
- `identification_hash` (cross-session matching helper)
- `identification_hashes` (all account-number-derived hashes)

## Error Model

Error response fields:

- `message`
- `code` (HTTP-like code)
- `error` (error enum)
- `detail`

Common relevant errors:

- `WRONG_REQUEST_PARAMETERS`
- `WRONG_AUTHORIZATION_CODE`
- `EXPIRED_AUTHORIZATION_CODE`
- `EXPIRED_SESSION`
- `SESSION_DOES_NOT_EXIST`
- `ASPSP_RATE_LIMIT_EXCEEDED`
- `PSU_HEADER_NOT_PROVIDED`
- `ACCESS_DENIED`

## Notes For Actual Integration

- Use `GET /aspsps` + `POST /auth` + callback + `POST /sessions` for linking.
- Persist `session_id` as bank-level remote identifier.
- Persist account `uid` as account-level remote id.
- Keep `identification_hash` for future stable remapping.
- Normalize transactions into Actual bank-sync shape:
  - `transactions.all`
  - `transactions.booked`
  - `transactions.pending`
  - `balances`
  - `startingBalance`
