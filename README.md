# Jomarkhata backend (jomarKhata-be)

Node.js + Express 5 + TypeScript + MongoDB (Mongoose). Login is **Firebase Authentication**
(Google or email + password): Firebase stores and hashes passwords; this server never sees them.
Every request carries a Firebase ID token, which the server verifies with Firebase Admin.

The API contract lives in the frontend repo: `jomarKhata-fe/docs/BACKEND_CONTRACT.md`.

## Run locally
```bash
npm install
cp .env.example .env    # then fill in the values (see below)
npm run dev             # http://localhost:4000/health
npm test                # API tests (in-memory MongoDB, fake tokens; no internet needed)
```

## Production

**Free start: Vercel** (a separate Vercel project for this repo)
- `api/index.ts` is a serverless function and `vercel.json` sends every path to it, so there's no sleeping server.
- Steps:
  1. Vercel → Add New → Project → import this repo (no build settings needed).
  2. Add every variable from `.env` in Settings → Environment Variables.
  3. Deploy, then open `https://<project>.vercel.app/health`.
  4. Put that URL in the frontend's `NEXT_PUBLIC_API_URL` (Vercel env of jomarKhata-fe) and add the frontend URL to `CORS_ORIGINS` here.
- MongoDB Atlas → Network Access: allow `0.0.0.0/0`, because Vercel has no fixed IP.
- Note: the Vercel Hobby plan is for non-commercial use. When the app earns, move to Vercel Pro or a small server.

**Any normal server** (Render, Railway, a VPS): run `npm run build && npm start` (entry: `src/index.ts`) with the same variables.

## Environment (.env)
| Variable | Where to get it |
|---|---|
| `MONGODB_URI` | MongoDB Atlas → Database → Connect → Drivers. Put `jomarkhata` as the DB name. Atlas → Network Access: allow your server's IP (or 0.0.0.0/0 while testing). |
| `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | Firebase console → Project settings → Service accounts → **Generate new private key** (JSON). Keep the key in double quotes with `\n`. |
| `SUPER_ADMIN_EMAILS` | Your own login email(s): these accounts get the super-admin role. |
| `CORS_ORIGINS` | `http://localhost:3000` plus your Vercel / production URL. |
| `TRIAL_DAYS` | Free trial for new accounts (default 30). |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_ID` | Optional. Bot from @BotFather; your chat ID from @userinfobot. |
| `ADMIN_URL` | Optional. Admin panel URL for Telegram links. |

## API (v1)
| Method | Path | Notes |
|---|---|---|
| GET | `/health` | liveness + server time |
| GET | `/config` | public settings (trial days, referral rate) |
| POST | `/auth/session` | after Firebase sign-in; creates the account on first login (unique account ID, referral code, trial); body `{ referralCode? }` |
| GET | `/me` | the signed-in account |
| GET | `/subscription` | `{ status, expiresAt, serverTime }` |
| GET | `/admin/me` | super admin only |
| GET/PUT | `/admin/settings` | super admin: WhatsApp number, payment numbers, trial days, referral rate, Telegram chat IDs (no env change needed) |

Security: helmet, CORS allow-list, rate limit (120/min/IP), 1 MB JSON limit, token revocation check,
blocked accounts refused, no passwords stored, secrets only in `.env` (git-ignored).
