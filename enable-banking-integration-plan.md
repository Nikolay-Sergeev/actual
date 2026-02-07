# Enable Banking Integration Plan

Reference documentation: `enable-banking-api-reference.md`

## Isolation Constraints (Must Hold Across All Steps)

1. Enable Banking must be added as a standalone integration.

- Only additive changes for the new provider are allowed.
- Do not modify existing provider modules: `app-gocardless`, `app-simplefin`, `app-pluggyai`.
- Do not change existing provider request/response contracts, auth flows, or sync behavior.

2. Shared code changes are allowed only when required to register a new provider.

- Allowed examples: provider unions, route registration, new modal/thunk wiring, docs updates.
- Disallowed examples: refactors or fixes to existing provider logic as part of this scope.

## Deep Code Analysis

1. Current bank-sync integration is a 3-layer flow.

- `sync-server` exposes provider HTTP adapters (`/gocardless`, `/simplefin`, `/pluggyai`) in `packages/sync-server/src/app.ts:57`.
- `loot-core` calls those adapters and reconciles transactions in `packages/loot-core/src/server/accounts/sync.ts:1019`.
- `desktop-client` drives setup/linking via provider-specific modals and thunks in `packages/desktop-client/src/components/modals/CreateAccountModal.tsx:63` and `packages/desktop-client/src/accounts/accountsSlice.ts:261`.

2. Provider support is currently hard-coded in many unions/switches.

- `AccountSyncSource` is fixed to 3 providers in `packages/loot-core/src/types/models/account.ts:25`.
- `BankSyncProviders` is fixed to 3 providers in `packages/loot-core/src/types/models/bank-sync.ts:23`.
- Sync download switch throws for unknown source in `packages/loot-core/src/server/accounts/sync.ts:1051`.
- UI labels are hard-coded in `packages/desktop-client/src/components/banksync/index.tsx:29` and `packages/desktop-client/src/components/mobile/banksync/MobileBankSyncPage.tsx:28`.

3. Linking contract today is provider-specific but shape-compatible.

- GoCardless links through `gocardless-accounts-link` in `packages/loot-core/src/server/accounts/app.ts:54`.
- SimpleFIN and Pluggy link via their own handlers in `packages/loot-core/src/server/accounts/app.ts:55`.
- Account mapping modal only accepts these 3 sync sources in `packages/desktop-client/src/components/modals/SelectLinkedAccountsModal.tsx:85`.
- Linking preselects by `external account_id -> local account.id` in `packages/desktop-client/src/components/modals/SelectLinkedAccountsModal.tsx:145`, so rotating remote IDs can break auto-relink behavior.

4. Sync behavior has provider quirks you need to preserve.

- Sync start date is clamped to 90 days in `packages/loot-core/src/server/accounts/sync.ts:92`.
- Bank-sync normalization expects `date`, `payeeName`, optional `notes`, and prefers `transactionId` in `packages/loot-core/src/server/accounts/sync.ts:410`.
- Initial balance math is provider-conditional for SimpleFIN/Pluggy in `packages/loot-core/src/server/accounts/sync.ts:938`.
- SimpleFIN gets special batch sync in both core API and client flow in `packages/loot-core/src/server/api.ts:273` and `packages/desktop-client/src/accounts/accountsSlice.ts:460`.

5. Sync-server provider modules follow a common response envelope.

- `loot-core` `post()` requires `{ status: 'ok', data: ... }` in `packages/loot-core/src/server/post.ts:75`.
- Provider endpoints generally expose `/status`, `/accounts`, `/transactions` in `packages/sync-server/src/app-simplefin/app-simplefin.js:14` and `packages/sync-server/src/app-pluggyai/app-pluggyai.js:14`.
- GoCardless adds an auth-redirect bridge (`/link`) and polling flow in `packages/sync-server/src/app-gocardless/app-gocardless.js:24` and `packages/desktop-client/src/gocardless.ts:22`.

6. Security posture is inconsistent across providers.

- GoCardless uses `validateSessionMiddleware` in `packages/sync-server/src/app-gocardless/app-gocardless.js:30`.
- SimpleFIN and Pluggy modules currently do not call `validateSessionMiddleware` in `packages/sync-server/src/app-simplefin/app-simplefin.js:11` and `packages/sync-server/src/app-pluggyai/app-pluggyai.js:11`.
- Secrets API itself is session-protected in `packages/sync-server/src/app-secrets.js:15`.

7. There is existing type drift to fix while touching provider unions.

- DB type union omits Pluggy (`'simpleFin' | 'goCardless'`) in `packages/loot-core/src/server/db/types/index.ts:24` while runtime uses `'pluggyai'` in `packages/loot-core/src/server/accounts/app.ts:300`.
- Adding Enable Banking is a good time to normalize this.

8. Docs and lints also encode provider names.

- Supported providers doc is explicit in `packages/docs/docs/advanced/bank-sync.md:14`.
- Provider name whitelist for untranslated strings is explicit in `packages/eslint-plugin-actual/lib/rules/no-untranslated-strings.js:19`.

## Implementation Plan

1. Define the Enable Banking integration contract and identifier strategy.

- `Decision:` Use provider key `enableBanking` in app/DB unions and `/enablebanking` HTTP route on sync-server.
- `Decision:` Store bank-level `session_id` in `banks.bank_id` and account-level remote id in `accounts.account_id`.
- `Decision:` Include `identification_hash` in external account payload to support future stable remap.
- `Files:` `packages/loot-core/src/types/models/account.ts`, `packages/loot-core/src/types/models/bank-sync.ts`, `packages/loot-core/src/server/db/types/index.ts`, `packages/desktop-client/src/components/mobile/banksync/BankSyncAccountsList.tsx`.

2. Add sync-server provider module for Enable Banking.

- `Create:` `packages/sync-server/src/app-enablebanking/app-enablebanking.js`.
- `Endpoints:` `POST /status`, `POST /aspsps` (or `/banks` alias), `POST /create-auth`, `POST /poll-auth`, `POST /accounts`, `POST /transactions`, `POST /remove-account`.
- `Behavior:` Normalize to Existing BankSync payload shape (`transactions.all/booked/pending`, `balances`, `startingBalance`) matching `post()` contract in `packages/loot-core/src/server/post.ts:75`.
- `Security:` Apply `validateSessionMiddleware` for all state-changing/data endpoints; allow only callback endpoint public.
- `Constraint:` Do not edit middleware/security behavior in existing provider modules.

3. Implement Enable Banking JWT auth + secret handling.

- `Secrets:` Add secret names in `packages/sync-server/src/services/secrets-service.js:10` for app id / private key / environment (sandbox/prod).
- `JWT:` Generate RS256 JWT per request with `kid`, `iss`, `aud`, `iat`, `exp<=24h`.
- `Note:` `jws` already exists in `packages/sync-server/package.json:43`; may be sufficient unless you prefer `jose`.

4. Implement redirect + polling authorization bridge.

- `Pattern:` Mirror GoCardless modal flow in `packages/desktop-client/src/gocardless.ts:22`.
- `Server flow:` `create-auth` returns URL+state; callback stores `{state, code|error}`; `poll-auth` exchanges code for session + accounts.
- `Client flow:` open browser, poll until account list is ready, then open existing `select-linked-accounts` modal with `syncSource: 'enableBanking'`.

5. Wire sync-server route and loot-core server-config.

- `Add route mount:` `app.use('/enablebanking', ...)` in `packages/sync-server/src/app.ts:57`.
- `Add config URL:` `ENABLEBANKING_SERVER` in `packages/loot-core/src/server/server-config.ts:4`.
- `Add account handlers:` status/accounts/link/poll methods in `packages/loot-core/src/server/accounts/app.ts:49`.

6. Extend loot-core account handlers + sync logic.

- `Add link handler:` `enablebanking-accounts-link` in `packages/loot-core/src/server/accounts/app.ts:49`.
- `Add status/accounts handlers:` analogous to `simplefin-status` and `simplefin-accounts` at `packages/loot-core/src/server/accounts/app.ts:663`.
- `Add sync branch:` `downloadEnableBankingTransactions` + switch branch in `packages/loot-core/src/server/accounts/sync.ts:1036`.
- `Add unlink cleanup:` if last account for a bank/session, call sync-server provider cleanup (similar to GoCardless cleanup path in `packages/loot-core/src/server/accounts/app.ts:1199`).

7. Extend desktop-client setup and linking UI.

- `Create init modal:` `EnableBankingInitialiseModal` and register it in `packages/desktop-client/src/components/Modals.tsx:176`.
- `Add modal union:` `enablebanking-init` in `packages/desktop-client/src/modals/modalsSlice.ts:95`.
- `Add status hook:` `useEnableBankingStatus` mirroring `packages/desktop-client/src/hooks/useSimpleFinStatus.ts:7`.
- `Add setup button/reset logic:` in `packages/desktop-client/src/components/modals/CreateAccountModal.tsx:383`.
- `Extend linked-account modal union/switch:` in `packages/desktop-client/src/components/modals/SelectLinkedAccountsModal.tsx:85`.
- `Extend provider labels:` desktop/mobile pages in `packages/desktop-client/src/components/banksync/index.tsx:29` and `packages/desktop-client/src/components/mobile/banksync/MobileBankSyncPage.tsx:28`.

8. Normalize types and model exports.

- `Create:` `packages/loot-core/src/types/models/enablebanking.ts`.
- `Export:` add to `packages/loot-core/src/types/models/index.ts:1`.
- `Update thunks:` add `linkAccountEnableBanking` in `packages/desktop-client/src/accounts/accountsSlice.ts:315`.
- `Update provider unions everywhere:` including mocks in `packages/loot-core/src/mocks/index.ts:42`.

9. Error mapping and UX consistency.

- `Map Enable Banking errors` to existing categories consumed by `AccountSyncCheck` in `packages/desktop-client/src/components/accounts/AccountSyncCheck.tsx:23`.
- `Ensure rate-limit, auth-expired, bad-credentials` produce actionable `error_type/error_code`.
- `Add provider display string` to untranslated whitelist if used raw in JSX in `packages/eslint-plugin-actual/lib/rules/no-untranslated-strings.js:19`.

10. Tests and verification.

- `sync-server:` add unit tests for JWT signing, callback state handling, pagination continuation logic, and error mapping.
- `loot-core:` add tests for new provider switch path and account linking/unlinking behavior.
- `desktop-client:` add component tests for new setup modal and Create Account provider path.
- `Run from root:` `yarn typecheck`, `yarn lint:fix`, targeted tests, then full `yarn test`.

11. Docs updates.

- `Add provider docs:` `packages/docs/docs/advanced/bank-sync/enablebanking.md`.
- `Update supported list:` `packages/docs/docs/advanced/bank-sync.md:14`.
- `Document secrets, callback URL, sandbox/prod differences, consent expiration/relink behavior`.

## Key Risks To Resolve Before Coding

1. Enable Banking account IDs may rotate per session (`uid`), while Actual currently relies on stable `account_id` mapping in `packages/desktop-client/src/components/modals/SelectLinkedAccountsModal.tsx:145`.

- Decide whether v1 accepts manual remap on reauth or introduces stable hash persistence.

2. Decide whether to include balances on every sync call or initial-only.

- Reference pattern: `packages/sync-server/src/app-gocardless/app-gocardless.js:151` and `packages/loot-core/src/server/accounts/sync.ts:1047`.

3. Decide whether to keep batch optimization SimpleFIN-only, or add Enable Banking batching if API limits allow.

4. Keep existing provider middleware posture unchanged in this scope.

- Any SimpleFIN/Pluggy security hardening should be a separate PR.
