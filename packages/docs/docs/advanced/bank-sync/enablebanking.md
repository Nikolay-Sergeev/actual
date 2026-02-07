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
   - **App ID**
   - **Private key (PEM)**
   - **Environment** (`SANDBOX` or `PRODUCTION`)
   - **Redirect URL** (optional, usually auto-filled)
4. Click **Save and continue**.

For reference, these values are stored in server secrets as:

- `enablebanking_applicationId`
- `enablebanking_privateKey`
- `enablebanking_environment`
- `enablebanking_redirectUrl`

If you leave `enablebanking_redirectUrl` blank, Actual will try to infer the callback
URL from the server's public origin (based on request headers like `Host`,
`X-Forwarded-Host`, and `X-Forwarded-Proto`).

If your Actual server runs behind a reverse proxy, Docker bridge, or any non-direct/public
origin mapping, set `enablebanking_redirectUrl` to the public callback URL that the bank
can reach (for example `https://budget.example.com/enablebanking/callback`).

## 3. Link your bank accounts

1. Start the **Link bank account with Enable Banking** flow from Add Account or Link Account.
2. Choose country and bank.
3. Actual opens Enable Banking in a new browser tab. Complete the bank authorization.
4. After authorization, your bank/provider redirects back to your Actual server callback URL
   (`/enablebanking/callback`).
5. Return to Actual and select which discovered accounts to link.

:::tip
If no browser tab opens (commonly due to browser popup blocking, especially in Firefox),
the "Link your bank" dialog includes a retry link you can click to open the authorization
tab again.
:::

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

## Troubleshooting

### Linking keeps spinning / pending

Actual polls the server while you are completing authorization (up to 10 minutes). If the
status stays "pending" even after you completed the bank flow, the callback may not have
reached the server.

Things to check:

1. Make sure your Enable Banking application allows the exact redirect URL you are using.
2. Confirm the callback URL is reachable from the bank/provider:
   - It must be a public URL (not `localhost`) for real bank connections.
3. If you are using the web app in a browser with a service worker enabled:
   - Ensure the `/enablebanking/*` route isn't being served by the SPA shell (`index.html`).
   - Try a hard refresh, a private window, or unregister the service worker and retry the flow.
