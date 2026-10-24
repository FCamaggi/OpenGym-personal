# Deploying on Render (this fork)

Two services, both built from this repo:

| Service | Type | Dockerfile path | Docker build context |
|---|---|---|---|
| `opengym-api-personal` | Web Service | `api/Dockerfile` | `api` |
| `opengym-web-personal` | Web Service | `web/Dockerfile` | `.` (repo root) |

## API (`opengym-api-personal`)

Attach a persistent disk mounted at `/data`, then set:

- `DATA_DIR=/data`
- `PORT=3000`
- `TRUST_PROXY=1`
- `RP_ID=opengym-web-personal.onrender.com`
- `ORIGIN=https://opengym-web-personal.onrender.com`

## Web (`opengym-web-personal`)

The API is reached through its public HTTPS address, so nginx needs:

- `BACKEND=opengym-api-personal.onrender.com`
- `BACKEND_SCHEME=https`
- `BACKEND_HOST_HEADER=opengym-api-personal.onrender.com` (Render routes by Host header)
- `PORT=443`
- `RESOLVER=1.1.1.1`
- `NGINX_PORT=10000` (Render's default port; or set the service's PORT to match)

If the API is a Render *private service* instead, use `BACKEND=opengym-api-personal`,
`BACKEND_SCHEME=http`, `PORT=3000` and leave `BACKEND_HOST_HEADER` unset.
