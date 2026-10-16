# Erzsi 2.0

For installation, Firebase environment configuration, and deployment instructions, see [Firebase Environments: Quick Setup and Deployment](docs/FIREBASE-ENVIRONMENTS.md).

## Local Development

Run the app with:

```bash
npm run dev
```

The Vite dev server is configured to listen on all network interfaces at port `3000`, so it can be opened from another device on the same Wi-Fi network.

## Testing On A Phone

1. Start the app with `npm run dev`.
2. Find your computer's local IP address.
3. Open `http://YOUR-IP:3000` on your phone.

Example:

```text
http://192.168.1.25:3000
```

Requirements:

- Your computer and phone must be on the same local network.
- Windows Firewall must allow Node.js or port `3000` on your private network.
- If you want to test the production build from a phone, run `npm run build` and then `npm run preview`, then open `http://YOUR-IP:4173`.
