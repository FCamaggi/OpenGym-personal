# Free-tier deployment: Vercel (web) + Render (API) + MongoDB Atlas (data)

```
browser ──► Vercel (static app, /api rewrite) ──► Render (api container) ◄──► MongoDB Atlas M0
            one origin, so passkeys work           files in /data, mirrored
```

## 1. MongoDB Atlas (M0, free)

1. Create a free cluster, a database user (user + strong password) and, under Network Access,
   allow `0.0.0.0/0` (Render's free tier has no fixed outbound IP; the password is the protection).
2. Copy the connection string: `mongodb+srv://USER:PASS@cluster.../?retryWrites=true&w=majority`.

## 2. Render: `opengym-api-personal` (Web Service, Docker)

Dockerfile `api/Dockerfile`, context `api`. No disk needed. Environment:

| Variable | Value |
|---|---|
| `MONGODB_URI` | the connection string above |
| `MONGODB_DB` | `opengym` (optional) |
| `DATA_DIR` | `/data` |
| `PORT` | `3000` |
| `TRUST_PROXY` | `1` |
| `RP_ID` | your Vercel domain, e.g. `opengym-personal.vercel.app` |
| `ORIGIN` | `https://opengym-personal.vercel.app` |

The `opengym-web-personal` Render service is no longer needed.

How the mirror works (`api/mirror.js`): the API keeps using files in `/data`. At boot they are
restored from Mongo; afterwards every change to `db.json`, `state-*.json`, `secret`, `vapid.json`,
`coach*.json` and `audit.log` is uploaded, and a write is answered only once it is in Mongo. If
`MONGODB_URI` is set but Mongo cannot be reached the API refuses to start. Not mirrored: photos and
videos of custom exercises (`uploads/`), which are lost on a restart.

An existing instance migrates itself: with an empty Mongo, the files found in `/data` at first boot
are uploaded.

## 3. Vercel (Hobby, free, personal use)

Import the repo (root directory = repo root). `vercel.json` already sets the build, the output and
the `/api` rewrite to `https://opengym-api-personal.onrender.com`. Edit that URL if your API
service has another name. Then set `RP_ID` / `ORIGIN` on Render to the domain Vercel gave you.

Passkeys are bound to `RP_ID`: accounts created under the old Render domain have to be
signed in again with a new passkey (or password), and the data is not lost.

## Known limits

- Render free sleeps after ~15 min idle; the first request wakes it (about a minute).
- Vercel proxies `/api` for at most 120 s per request, so a long Coach call can be cut.
- Atlas M0: 512 MB, 100 ops/s.
- Two API instances at once (Render's overlap during a deploy) can each hold a different copy for a
  few seconds; with one user this is unlikely to matter.
