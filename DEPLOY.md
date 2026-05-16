# Deploying aionui-cowork on a single VM

This guide walks through a fresh install of the dockerized fork on one Linux
VM. Multi-tenant signup is enabled by default and the first registered user
gets the admin role.

## 1. Host requirements

- Linux x86_64 or arm64. Tested with Ubuntu 22.04 and Debian 12.
- Docker Engine ≥ 24 (with the Compose v2 plugin: `docker compose version`).
- Recommended sizing for ~20 active users:
  - 8 vCPU, 16 GB RAM, 200 GB SSD.
  - Each chat session spins up its own sandbox container (1 GiB / 0.5 CPU
    by default — see `SESSION_*` env vars below).
- Outbound HTTPS to:
  - `ghcr.io` (image pulls)
  - LLM providers your users will hit (`api.anthropic.com`,
    `generativelanguage.googleapis.com`, …)

## 2. Pull the repo and prepare env

```bash
git clone https://github.com/4ekuct25/aionui-cowork.git
cd aionui-cowork
git checkout dockerize       # until the fork branch is merged to main

cp .env.example .env
# Edit .env, at minimum:
#   - CSRF_SECRET    = $(openssl rand -hex 16)
#   - OIDC_*         = leave commented unless you operate Keycloak
```

## 3. Pull images

```bash
docker compose pull
# session-runtime is referenced by the app but not run as a long-lived
# service in compose; pre-cache it so first session start is fast:
docker compose --profile build-only run --rm session-runtime-puller
```

If you want to build from source instead of pulling:

```bash
docker compose build app                          # control-plane image
docker compose --profile build-only build session-runtime-builder
```

## 4. Start

```bash
docker compose up -d
docker compose logs -f app
```

The control-plane container listens on the port you configured in
`APP_PORT` (default 3000). `GET http://<host>:3000/api/health` returns
200 once the DB is ready — the compose healthcheck uses this.

## 5. Create the first admin

Open `http://<host>:3000/signup` in a browser. The first registration
becomes the admin; subsequent registrations are regular users.

`ENABLE_LOCAL_SIGNUP=true` (default) is required for that page to be
reachable. If you only want OIDC users, set it to `false` after the
first admin signs up so the public form disappears.

## 6. (Optional) Wire OIDC

In Keycloak (or any OIDC provider):

1. Create a confidential client with redirect URI
   `https://<host>:<port>/api/auth/oidc/callback`.
2. Fill `OIDC_*` in `.env` (uncomment the block).
3. `docker compose up -d --force-recreate app`.

The "Continue with SSO" button appears on `/login` once
`GET /api/auth/oidc/status` reports `enabled: true`.

## 7. Verify

```bash
# health
curl -fsS http://localhost:3000/api/health | jq

# Should return:
# {
#   "success": true,
#   "db": "ok",
#   "oidcEnabled": false,
#   "dockerMode": true,
#   "signupEnabled": true
# }

# After your first chat:
docker ps --filter "label=aionui.managed=true"
# A long-lived session container appears per active conversation.
```

## 8. Common operations

| Task                           | Command                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Tail control-plane logs        | `docker compose logs -f app`                                                                                  |
| Re-pull latest images          | `docker compose pull && docker compose up -d`                                                                 |
| Stop everything                | `docker compose down`                                                                                         |
| Drop user data (CAREFUL)       | `docker compose down -v`                                                                                      |
| List active sandbox containers | `docker ps --filter "label=aionui.managed=true"`                                                              |
| Inspect audit log              | `docker compose exec app sqlite3 /data/aionui.db 'SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 50'` |

## 9. TLS / reverse proxy

The control-plane exposes plain HTTP on `APP_PORT`. In production put it
behind a TLS-terminating proxy:

- Caddy (auto-Let's Encrypt) — drop-in `Caddyfile`:
  ```
  aionui.example.com {
    reverse_proxy 127.0.0.1:3000
  }
  ```
- Traefik / nginx work equivalently — just forward to `127.0.0.1:3000`.

Set `OIDC_REDIRECT_URI` to the HTTPS hostname your users see, not the
internal `127.0.0.1`.

## 10. Troubleshooting

- **First signup fails with 403** — `ENABLE_LOCAL_SIGNUP=false`. Flip
  it to `true` and recreate the app container.
- **Session never starts, chat hangs** — check
  `docker compose exec app cat /var/log/aionui.log` and
  `docker logs $(docker ps -lq --filter "label=aionui.managed=true")`.
  Most often the session-runtime image isn't local yet — run the
  build-only profile from step 3.
- **Healthcheck red** — `GET /api/health` returns the failing
  component; `db: error` usually means `/data` is read-only or the
  volume permissions are wrong.
- **docker.sock permission denied** — the compose stack mounts the
  host socket. The `app` container must be able to talk to it; on
  rootless docker setups follow the Docker rootless docs.

See `PLAN.md` for the full roadmap. Phase 8.2 (docker-socket-proxy)
will replace the bare-sock mount with a whitelisted proxy.
