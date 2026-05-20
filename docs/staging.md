# Firebase Staging Environment

This project uses build-time Firebase configuration. Production and staging must be separate Firebase projects.

## Project aliases

`.firebaserc` defines:

- `prod` -> `erzsi-2`
- `staging` -> `erzsi-2-staging`

If the staging project has a different ID, update the `staging` alias before deploying.

## Environment files

Local env files are intentionally ignored by git.

- `.env.production` contains the current live Firebase web app config.
- `.env.staging` must contain the staging Firebase web app config from Firebase Console.
- `.env.staging.example` shows the required keys.

Do not point staging at the production project.

## Commands

```bash
npm run build:prod
npm run deploy:prod

npm run build:staging
npm run deploy:staging
npm run deploy:staging:backend
npm run deploy:staging:hosting
```

## Seed staging demo data

First deploy staging backend, then authenticate Firebase Admin locally.

```bash
npm run deploy:staging:backend
npm run seed:staging
```

The seed creates:

- active event `staging-demo`
- demo personas with QR codes
- demo products and product barcodes
- one burger modifier template
- QR pool entries

Optional:

```bash
STAGING_PUBLIC_BASE_URL=https://staging.kasszaserzsi.hu npm run seed:staging
```

## Tester accounts

Create tester accounts in the staging Firebase Auth project only. They can be admin/staff inside staging without being able to touch production data.
