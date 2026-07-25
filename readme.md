# Karnataka State Police Portal (KSPP)

Secure React portal for FIR registration, case search, operational dashboards,
reports, officer notification settings, and an AI-assisted case query workflow.

## Requirements

- Node.js 20
- Google service-account access to the configured master and consolidated sheets
- Firebase project settings if Firebase sign-in fallback is used
- At least one Gemini or Groq key for Copilot
- Twilio credentials for OTP and SMS alerts

## Local setup

1. Copy `.env.example` to `.env`.
2. Fill all required values. Never commit `.env` or a service-account key.
3. Install dependencies with `npm ci`.
4. Start the portal with `npm run dev`.

The local address is `http://localhost:5173`.

## Verification

Run the complete local quality gate:

```text
npm run verify
```

This checks TypeScript, server security/OTP/SMS tests, and the production build.

## Authentication and authorization

- Login is validated by the server against the Employee sheet.
- The browser receives a signed, HTTP-only session cookie; browser storage is
  not trusted as proof of identity.
- New passwords are stored as salted scrypt hashes. The temporary `FirstAuth`
  value is cleared after a successful change.
- Constables can only read or update cases assigned to them or their station.
  Inspectors and SP users can access the wider case set.
- The server derives the employee, role, and station from the signed session.
  Values sent by the browser are never trusted for access control.
- Login, OTP, and Copilot routes are rate limited.

## FIR drafts

New FIR steps are kept in `sessionStorage`, scoped to the signed-in employee and
browser tab. A draft survives a page refresh in that tab and is removed after
submission or logout. Only **Submit FIR** writes the case and its related rows to
Google Sheets. Failed submissions remain visibly failed and retain the draft.

## Production and Zoho Catalyst AppSail

The production server is `catalyst-server.mjs`. It serves the built SPA and API
from one process, listens on `X_ZOHO_CATALYST_LISTEN_PORT`, and exposes:

- `/healthz` for platform health checks
- `/api/health` for application health checks

`app-config.json` uses a relative `./appsail-build` build path. Its pre-deploy
script builds the frontend and copies only the runtime files into that folder,
so local `.env` and service-account files are not bundled.

Before deployment, configure all values from `.env.example` in the AppSail
environment settings, especially:

- `SESSION_SECRET`
- Google Sheet IDs and `GOOGLE_SERVICE_ACCOUNT_JSON`
- Firebase settings
- Copilot provider keys
- Twilio and OTP settings

To prepare the bundle locally:

```text
npm run appsail:prepare
```

The generated `appsail-build` directory is intentionally ignored by Git.

## Important operational notes

- Google Sheet IDs have no built-in production fallback; missing configuration
  fails clearly instead of connecting to an unintended sheet.
- Copilot receives a small allowlisted case context after server-side role
  filtering. Users should still verify AI output against the source record.
- CSV and report output follows the selected date range.
- SMS alerts only target verified, opted-in officers selected by the routing
  rules.
