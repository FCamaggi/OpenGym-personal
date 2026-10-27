# Free-tier deployment: Vercel (web) + Render (API) + MongoDB Atlas (data)

The web app runs on Vercel and the API on Render; the data lives in MongoDB Atlas, so Render's disk
being lost on restart no longer matters.

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
| `RP_ID` | your Vercel hostname, e.g. `opengym.vercel.app` |
| `ORIGIN` | `https://opengym.vercel.app` (your Vercel URL) |

How the mirror works (`api/mirror.js`): the API keeps using files in `/data`. At boot they are
restored from Mongo; afterwards every change to `db.json`, `state-*.json`, `secret`, `vapid.json`,
`coach*.json` and `audit.log` is uploaded, and a write is answered only once it is in Mongo. If
`MONGODB_URI` is set but Mongo cannot be reached the API refuses to start. Not mirrored: photos and
videos of custom exercises (`uploads/`), which are lost on a restart.

An existing instance migrates itself: with an empty Mongo, the files found in `/data` at first boot
are uploaded.

## 3. Vercel: the web app (free)

Vercel serves the static app (always awake, no cold start) and proxies `/api` to the Render API
through `vercel.json`, so the browser sees one origin, as passkeys require.

1. Import the repo in Vercel. Leave the framework preset empty: `vercel.json` already sets the
   install/build commands and the output directory (`frontend/dist`).
2. If your API is not at `opengym-api-personal.onrender.com`, edit the `rewrites` destination in
   `vercel.json`.
3. On the Render API service change `RP_ID` to your Vercel hostname (e.g. `opengym.vercel.app`)
   and `ORIGIN` to `https://opengym.vercel.app`, then redeploy it.
4. Delete the `opengym-web-personal` Render service once the Vercel site works.

**Passkeys are bound to the hostname.** Passkeys created on `*.onrender.com` do not work on the
Vercel hostname, so register a new one on first visit. Keep the hostname fixed from now on (a custom
domain is the way to make it permanent).

## Known limits

- The Render API still sleeps after ~15 min idle; the app shell loads instantly from Vercel, but the
  first API call after idling waits for it to wake (about a minute).
- Atlas M0: 512 MB, 100 ops/s.
- Two API instances at once (Render's overlap during a deploy) can each hold a different copy for a
  few seconds; with one user this is unlikely to matter.
