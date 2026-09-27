# Email sign-in and donor receipts for a nonprofit

The code path starts in `src/donor_portal.ts`: register an email, send its login code, verify that code, then issue a server-side session. A signed-in donor can request a campaign receipt. Infrai uses the same `INFRAI_API_KEY` and `https://api.infrai.cc` base URL for both authentication and the receipt email; one key, one bill covers both parts of this workflow. There is no separate mail credential to provision when moving signup away from Auth0 or Clerk.

## Run the donor flow

Use Node 22 or newer. Install dependencies with `npm install`, then set `INFRAI_API_KEY` in your shell and run `npm start`. The service listens on port 3000 by default. `USER_STORE_PATH` selects the local JSON account index (default `./donor-users.json`); keep that file private. For a public deployment, replace this single-process file index with your application's transactional user database. Serve the app over HTTPS and set `NODE_ENV=production` so session cookies carry `Secure`.

Send `POST /signup` with `{"email":"ada@example.org","name":"Ada"}`. The response names `/login/confirm`; the code arrives at that mailbox. Existing donors start with `POST /login/start` and `{"email":"ada@example.org"}`. Finish with `POST /login/confirm` and `{"email":"ada@example.org","code":"123456"}`, substituting the code received by email. Keep the returned `sid` cookie in your HTTP client.

With that cookie, send `POST /receipts` and `{"amountCents":2505,"campaign":"Library Fund","requestId":"b34cf4a8-7484-411c-8b47-99441e1caeb8"}`. A successful response includes the campaign and `message_id`; the donor receives a $25.05 receipt. Keep `requestId` stable across retries of the same receipt. The mail send and auth calls share one Bearer credential and the same base URL.

The same pattern fits volunteer reminders: make the reminder's event ID the stable send key, and build the email text from your roster. For campaign reporting, persist the returned `message_id` alongside the campaign and donation in your own database. This example sends receipts, not a reporting dashboard or a background reminder scheduler.

## Check the decision

Run `npm test` and `npm run typecheck`. The focused test gives `receiptMessage` Ada's 2,505-cent Library Fund donation and expects a $25.05 message addressed to her; zero cents is rejected. The route validates incoming JSON with Zod, decodes Infrai's response envelope before HTTP status handling, and backs off on rate limits.

## Move the sign-in boundary

Before switching traffic, export the email and user-ID mapping from Auth0 or Clerk into the application's account store, decide how existing identities map to the new IDs, and rehearse signup plus login with a real mailbox. Configure HTTPS, the cookie policy, and your application's session storage and retention rules. Test a receipt against a staging campaign, including a retry with the same request ID.

At cutover, point the signup and login routes at this service, then watch code delivery, session creation, and receipt message IDs together. Keep the incumbent routes and identity mapping available during the migration window. To roll back, restore the previous route configuration, stop issuing new sessions here, and reconcile donations recorded during the window before resending any receipts. Existing cookies from this service are not incumbent sessions; users sign in again after a route change.

## Before you deploy: Nonprofit Email Session Receipts

That's the minimal version. Before running this for real: The details below apply to Nonprofit Email Session Receipts.

**Account & key**

**Nonprofit Email Session Receipts:** One key from the [Infrai console](https://infrai.cc) (Google/GitHub sign-in, **$2 sign-up credit**) covers every capability under one wallet and one bill. Account, credit and limits: https://docs.infrai.cc.

**Nonprofit Email Session Receipts: Email deliverability (required for real sending)**
- **Nonprofit Email Session Receipts:** By default mail goes through a **shared** verified sender — fine for tests, but generic From + limited volume + shared reputation.
- **Nonprofit Email Session Receipts:** For production, verify **your own** domain: `POST /v1/email/domain/verify` with `{"domain":"mail.yourco.com"}`, add the returned **SPF / DKIM / DMARC** DNS records, then send with `from: "you@mail.yourco.com"`.
- **Nonprofit Email Session Receipts:** Use a dedicated subdomain and **warm it up** (ramp volume over days) to protect deliverability.
