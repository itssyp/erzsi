# Firebase Environments: Quick Setup and Deployment

This repository uses two separate Firebase projects:

| Environment | Firebase project | Alias | Local env file |
| --- | --- | --- | --- |
| Development/staging | `erzsi-2-staging` | `staging` | `.env.staging` |
| Production | `erzsi-2` | `prod` | `.env.production` |

Local development uses the staging project by default. Do not use production Firebase values in `.env.staging`.

## 1. Install the required tools

Install Node.js `20.19+` or `22.12+`. The installed Vite version requires one of these ranges, while Cloud Functions is configured for the Node 20 runtime. Node.js includes `npm`.

Then install the Firebase CLI:

```bash
npm install -g firebase-tools
firebase login
```

Confirm the tools are available:

```bash
node --version
npm --version
firebase --version
```

## 2. Clone or update the repository

For a new checkout:

```bash
git clone https://github.com/itssyp/erzsi.git
cd erzsi
git switch dev
```

For an existing checkout, first commit or stash local changes, then update the development branch:

```bash
git switch dev
git pull origin dev
```

## 3. Install dependencies

The web application and Cloud Functions have separate packages:

```bash
npm install
npm --prefix functions install
```

Install the separate test package when running Firebase tests:

```bash
npm --prefix tests install
```

## 4. Configure environment variables

Firebase web configuration is copied from Firebase Console:

`Project settings → General → Your apps → Web app → SDK setup and configuration`

Create `.env.staging` from `.env.staging.example`:

```dotenv
VITE_APP_ENV=staging
VITE_APP_ENV_LABEL=STAGING
VITE_FB_API_KEY=...
VITE_FB_AUTH_DOMAIN=erzsi-2-staging.firebaseapp.com
VITE_FB_PROJECT_ID=erzsi-2-staging
VITE_FB_STORAGE_BUCKET=...
VITE_FB_SENDER_ID=...
VITE_FB_APP_ID=...
VITE_FCM_VAPID_KEY=...
```

Create `.env.production` with the equivalent values from the `erzsi-2` production project:

```dotenv
VITE_APP_ENV=production
VITE_APP_ENV_LABEL=
VITE_FB_API_KEY=...
VITE_FB_AUTH_DOMAIN=erzsi-2.firebaseapp.com
VITE_FB_PROJECT_ID=erzsi-2
VITE_FB_STORAGE_BUCKET=...
VITE_FB_SENDER_ID=...
VITE_FB_APP_ID=...
VITE_FCM_VAPID_KEY=...
```

These files are intentionally ignored by Git. Never commit populated environment files. Variables beginning with `VITE_` are embedded in browser JavaScript and must not contain private server secrets.

For food-order push notifications, generate a separate **Web Push certificate/VAPID key pair** in each project's Firebase Console under `Project settings → Cloud Messaging → Web configuration`. Put only the **public** key in `VITE_FCM_VAPID_KEY`; never put the private key in a web env file. Enable the FCM Registration API for both projects if prompted. Push remains hidden in the participant UI until this key is configured and the web app is rebuilt. Deploy Hosting, Firestore Rules, and Functions together. On iPhone/iPad, test from the installed Home Screen web app (iOS/iPadOS 16.4 or later), not a regular Safari tab.

Cloud Functions also use the `BOOTSTRAP_ADMIN_EMAILS` string parameter. It contains a comma-separated list of e-mail addresses allowed to bootstrap themselves as administrators. Configure it separately for staging and production when the Firebase CLI prompts during Functions deployment. Keep the production list minimal.

## 5. Verify Firebase project aliases

The checked-in `.firebaserc` already maps:

```text
staging → erzsi-2-staging
prod    → erzsi-2
```

Check that your Firebase account can access both projects:

```bash
firebase projects:list
firebase use
```

## 6. Run locally

Run the normal development environment against staging:

```bash
npm run dev
```

The application opens at `http://localhost:3000`. It also listens on the local network, so a phone can use `http://YOUR-COMPUTER-IP:3000`.

Run locally with production configuration only when explicitly needed:

```bash
npm run dev:prod
```

This connects the local UI to live production data, so treat it as a privileged operation.

## 7. Validate before deployment

```bash
npm run lint
npm run build:staging
node tests/01-unit-tests.js
node tests/05-qr-carryover-regression.js
```

For the full emulator suite, ensure `node`, `npm`, and `firebase` are all available in `PATH`, then run:

```bash
node tests/run-emulator-tests.js
```

## 8. Deploy to staging

Deploy Hosting, Functions, Firestore Rules, and indexes:

```bash
npm run deploy:staging
```

Or deploy only part of staging:

```bash
npm run deploy:staging:backend
npm run deploy:staging:hosting
```

Optional demo data can be created after the staging backend is deployed and Application Default Credentials are configured:

```bash
npm run seed:staging
```

The staging seed writes data to the `staging-demo` event. Do not run it against production.

## 9. Deploy to production

First confirm `.env.production`, the Firebase alias, the active Git branch/commit, and the staging test results. Then run:

```bash
npm run deploy:prod
```

This builds the production frontend and performs a full Firebase deploy. If Firestore indexes changed, wait until Firebase reports that the indexes are ready before relying on the new queries.

## Recommended workflow

1. Pull `dev` and install dependencies.
2. Develop locally against `erzsi-2-staging`.
3. Run lint, tests, and a staging build.
4. Deploy and smoke-test staging.
5. Merge/promote the reviewed commit according to the team's Git process.
6. Verify production environment variables and deploy with `npm run deploy:prod`.
7. Smoke-test login, active event, QR lookup, top-up, checkout, kitchen status, and refund.
