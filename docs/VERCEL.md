# Free-tier deployment: Vercel (web + API) + MongoDB Atlas (data)

Two Vercel projects from this repo, no sleeping server. The API runs as a serverless function and
keeps its data in MongoDB Atlas.

How the API works there (`VERCEL` env is set by Vercel, which switches `api/server.js` to
serverless mode): each request first pulls any newer files from Mongo into `/tmp`, runs the normal
handler, and the response is sent only once the changes are uploaded (`api/mirror.js`). WebAuthn
challenges are stored in Mongo (single use, TTL 5 min) because a sign-in's two requests may hit
different instances.

## 1. MongoDB Atlas (M0, free)

As in [RENDER.md](RENDER.md) §1. Network Access must allow `0.0.0.0/0` (Vercel has no fixed IPs).

## 2. Vercel project `opengym-api`

Import the repo, **Root Directory: `api`**, framework preset: Other. Environment variables:

| Variable | Value |
|---|---|
| `MONGODB_URI` | the Atlas connection string |
| `DATA_DIR` | `/tmp/data` |
| `RP_ID` | the hostname of the **web** project, e.g. `opengym.vercel.app` |
| `ORIGIN` | `https://opengym.vercel.app` |
| `TRUST_PROXY` | `1` |

An existing Render instance migrates itself: the data already in Mongo is what gets used.

## 3. Vercel project `opengym` (web)

Import the same repo, Root Directory empty (repo root); `vercel.json` sets the build. Edit the
`rewrites` destination in `vercel.json` to your API project's URL
(`https://opengym-api.vercel.app/api/:path*`). The browser only ever talks to the web project, so
passkeys see one origin.

## Limits compared with a normal server

- Passkeys are bound to the hostname: those made on `*.onrender.com` do not work here; register again.
- Rest-timer push notifications (a `setTimeout` in the API) do not fire: the function is frozen once it answers.
- Rate limits (sign-in throttling) and the live "presence" view are per instance, and all users share
  the address of Vercel's proxy hop. Fine for one person, weak against an attacker.
- Custom-exercise photos/videos (`uploads/`) are not persisted. Device-link pairing codes (mobile app) are in memory and unreliable.
- Request bodies are capped at 4.5 MB by Vercel.
- Two simultaneous writes from different instances can overwrite each other (last one wins).
- Not tested against a live Vercel deployment from this repo's CI; watch the first deploy's function logs.
