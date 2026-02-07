# Enable Banking Setup

:::note
Enable Banking bank sync requires `actual-server`.
:::

This guide covers how to connect Actual to Enable Banking for account syncing.

## 1. Register an Enable Banking application

1. Create or sign in to your Enable Banking account: https://enablebanking.com/sign-in/
2. Register a new application in either `SANDBOX` or `PRODUCTION`.
3. Add your Actual callback URL to the allowed redirect URLs:

   `https://<your-actual-server>/enablebanking/callback`

4. Save:
   - Application ID
   - Private key (PEM)

## 2. Configure Enable Banking in Actual

1. In Actual, open **+ Add account**.
2. Click **Set up Enable Banking**.
3. Fill in:
   - **Application ID**
   - **Private Key (PEM)**
   - **Environment** (`SANDBOX` or `PRODUCTION`)
4. Click **Save and continue**.

For reference, these values are stored in server secrets as:
- `enablebanking_applicationId`
- `enablebanking_privateKey`
- `enablebanking_environment`

## 3. Link your bank accounts

1. Start the **Link bank account with Enable Banking** flow from Add Account or Link Account.
2. Choose country and bank.
3. Continue in your browser and complete bank authorization.
4. Return to Actual and select which discovered accounts to link.

## Sandbox vs Production

- `SANDBOX`
  - Uses simulated/sandbox institutions.
  - Useful for setup and integration testing.
- `PRODUCTION`
  - Uses live institutions.
  - App activation may require Enable Banking approval and production onboarding.

## Consent expiration and relinking

- Bank consents can expire or be revoked by the bank or user.
- When this happens, sync can fail with a reauthorization-required error.
- In Actual, use **Reauthorize** on the account sync warning to relink access.
- If you unlink the last Actual account using an Enable Banking session, Actual also requests session cleanup on the sync server.
