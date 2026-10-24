# Chromatic Arena

A polished full-stack web app with player accounts, email/phone/username login, signup, referral rewards, a virtual-credit color prediction game, wallet request workflow, private proof-image uploads, and an admin control room.

## Important wallet note

This starter is configured for **virtual credits and manual review only**. It does not connect to UPI, a bank, or a payment processor and does not move real money. The deposit/withdrawal screens are request workflows: players submit references/details and supporting images, then an admin reviews the request. Do not use this as a real-money gambling or payment product without appropriate legal/compliance review, age/location controls, a licensed payment provider, and a security review.

## Requirements

- Node.js 22.13 or newer
- npm

## Run locally

1. Copy `.env.example` to `.env`.
2. Change `SESSION_SECRET`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD`.
3. Install packages: `npm install`
4. Start: `npm start`
5. Open `http://localhost:3000`

The SQLite database is created at `data/arena.sqlite`. Uploaded account proof images are stored in `private_uploads/` and are not served as public static files. Keep both directories private and back them up securely.

## Demo OTP

`DEMO_OTP=true` logs generated OTP codes to the server console. No SMS/email provider is wired up. Before production, connect an OTP provider and bind verified OTPs to a one-time signup/login challenge; do not treat the demo console OTP as production verification.

## Admin login

The first run creates an admin account from `ADMIN_EMAIL` and `ADMIN_PASSWORD`. Sign in through the same login form using the admin email and password. Change these values before deployment. If you change the env values after the first run, the existing admin password in the database is not automatically reset.

## Main features

- Signup with username, email, phone, password confirmation, and optional referral code
- Sign in with username, email, or phone plus password
- Hashed passwords (bcrypt), hashed bearer session tokens, rate limits, Helmet headers
- Welcome credits and configurable referral rewards
- Server-side virtual-credit game picks and wallet transaction history
- Deposit request with payment reference and optional proof image
- Withdrawal request requiring a UPI QR image for UPI or passbook image for bank transfer
- Admin queue to view private proof images, approve/reject requests, adjust demo credits, and view audit events
- Responsive desktop and mobile UI

## Production hardening checklist

- Use HTTPS and secure reverse-proxy configuration.
- Set strong unique secrets; never commit `.env`, `data/`, or `private_uploads/`.
- Integrate a real email/SMS provider for OTP and implement verified challenge state.
- Add CSRF protections if switching to cookie-based sessions; review all auth/session and upload controls.
- Validate uploaded file content (not only MIME), scan files, set retention/deletion policy, and restrict access.
- Add backup, monitoring, incident response, privacy policy, terms, and any applicable regulatory requirements.
- Review game rules and any real-money/payment use with qualified legal and security professionals before production.
