# Free-tier deployment: Render (web + API) + MongoDB Atlas (data)

Two Render services built from this repo; the data lives in MongoDB Atlas, so Render's disk
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
| `RP_ID` | `opengym-web-personal.onrender.com` |
| `ORIGIN` | `https://opengym-web-personal.onrender.com` |

How the mirror works (`api/mirror.js`): the API keeps using files in `/data`. At boot they are
restored from Mongo; afterwards every change to `db.json`, `state-*.json`, `secret`, `vapid.json`,
`coach*.json` and `audit.log` is uploaded, and a write is answered only once it is in Mongo. If
`MONGODB_URI` is set but Mongo cannot be reached the API refuses to start. Not mirrored: photos and
videos of custom exercises (`uploads/`), which are lost on a restart.

An existing instance migrates itself: with an empty Mongo, the files found in `/data` at first boot
are uploaded.

## 3. Render: `opengym-web-personal` (Web Service, Docker)

Dockerfile `web/Dockerfile`, context `.` (repo root). nginx reaches the API through its public
HTTPS address:

- `BACKEND=opengym-api-personal.onrender.com`
- `BACKEND_SCHEME=https`
- `BACKEND_HOST_HEADER=opengym-api-personal.onrender.com` (Render routes by Host header)
- `PORT=443`
- `RESOLVER=1.1.1.1`
- `NGINX_PORT=10000` (Render's default port; or set the service's PORT to match)

If the API is a Render *private service* instead, use `BACKEND=opengym-api-personal`,
`BACKEND_SCHEME=http`, `PORT=3000` and leave `BACKEND_HOST_HEADER` unset.

## Known limits

- Render free sleeps after ~15 min idle; the first request wakes it (about a minute).
- Atlas M0: 512 MB, 100 ops/s.
- Two API instances at once (Render's overlap during a deploy) can each hold a different copy for a
  few seconds; with one user this is unlikely to matter.
