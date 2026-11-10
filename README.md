# ReelHub — Self-Hosted Reel Publishing & Automation Platform

## Prerequisites

- **Docker** ≥ 24.0 and **Docker Compose** v2 (`docker compose` — not `docker-compose`)
- **pnpm** ≥ 9 (`npm install -g pnpm`)
- **Node.js** LTS ≥ 20
- A host-side **cloudflared** tunnel pointing to `127.0.0.1:3000` (or your chosen `APP_PORT`)

---

## Directory Structure

```
reelhub/
├── apps/
│   ├── core/              # Fastify backend + API + Scheduler + State Machine
│   ├── dashboard/         # React 18 + Vite + Tailwind CSS frontend SPA
│   └── browser-worker/    # Playwright/Chromium worker (profile: browser)
├── packages/
│   └── shared/            # Shared Zod schemas and TypeScript types
├── docs/                  # Disaster recovery & runbooks
├── docker-compose.yml
├── .env.example
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── README.md
```

Host data bind-mounted from `/srv/reelhub/`:
```
/srv/reelhub/
├── db/               ← SQLite WAL files (must be local disk, never NFS)
├── videos/
│   ├── censored/     ← Instagram/Facebook videos (UUID-named)
│   ├── raw/          ← Telegram videos (deleted after verified delivery)
│   └── quarantine/   ← Replaced/cancelled files awaiting cleanup
├── temp/             ← In-flight uploads (purged on startup if >24 h old)
├── browser-profiles/ ← Chromium persistent profiles (browser worker only)
├── logs/             ← Application logs, failure screenshots
└── backups/          ← Encrypted SQLite backups
```

---

## First-Run Steps

### 1. Generate secrets

```bash
# Master encryption key (32 bytes hex)
openssl rand -hex 32 > /srv/reelhub/master_key
chmod 600 /srv/reelhub/master_key

# Session secret
SESSION_SECRET=$(openssl rand -hex 32)

# Browser worker shared secret
BROWSER_WORKER_SECRET=$(openssl rand -hex 32)
```

### 2. Create host directories

```bash
sudo mkdir -p /srv/reelhub/{db,videos/censored,videos/raw,videos/quarantine,temp,browser-profiles,logs,backups}
sudo chown -R $USER:$USER /srv/reelhub
chmod -R 750 /srv/reelhub
```

### 3. Configure environment

```bash
cp .env.example .env
# Edit .env with your values:
#   SESSION_SECRET=<generated above>
#   BROWSER_WORKER_SECRET=<generated above>
#   MASTER_KEY_FILE=/run/secrets/master_key  (or use MASTER_KEY=<hex>)
```

> **Important:** Store the master key backup **separately** from the database backups.
> Losing the master key makes stored tokens unrecoverable.

### 4. Start the core service

```bash
docker compose -p reelhub up -d core
# Watch logs:
docker compose -p reelhub logs -f core
```

### 5. Bootstrap the admin account

On first start (no admin exists), ReelHub prints a one-time setup token:

```
[BOOTSTRAP] No admin account found. One-time setup token: <TOKEN>
[BOOTSTRAP] POST /api/v1/auth/bootstrap with this token to create the admin account.
```

Copy the token and create the admin:

```bash
curl -X POST http://localhost:3000/api/v1/auth/bootstrap \
  -H "Content-Type: application/json" \
  -d '{"setupToken": "<TOKEN>", "username": "admin", "password": "<your-password>"}'
```

> Password minimum length: **12 characters**.

---

## Cloudflare Tunnel Setup

Point your host-side `cloudflared` tunnel to `127.0.0.1:3000` (or your `APP_PORT`).

```bash
# Example cloudflared config (/etc/cloudflared/config.yml):
url: http://localhost:3000
tunnel: <your-tunnel-id>
credentials-file: /etc/cloudflared/<tunnel-id>.json
```

ReelHub does **not** manage the tunnel — it only listens on `127.0.0.1`.

---

## Browser Worker (optional)

The browser worker is off by default. Enable only if you need Playwright-based workflows:

```bash
docker compose -p reelhub --profile browser up -d browser-worker
```

> This adds ~1.5 GB RAM usage. Monitor host memory usage for the first day.

---

## Health Check

```bash
curl http://localhost:3000/api/v1/system/health
# Expected: {"status":"ok","db":{"writable":true,"wal_mode":true},...}
```

---

## M0 Checklist (manual prerequisites)

Before connecting Meta/Instagram, complete these steps in the Meta Developer Console:

1. **Create a Meta developer app** at https://developers.facebook.com/apps
2. **Add products:** "Facebook Login for Business" + "Instagram" (Content Publishing)
3. **Add yourself as an app-role user** (so Standard Access covers your own accounts)
4. **Link your Instagram Business account to a Facebook Page**
5. **Add required permissions:**
   - `instagram_basic`, `instagram_content_publish`
   - `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`
6. **Create a Telegram bot** via @BotFather; add it as administrator to your channel
7. **Get a Gemini API key** from https://aistudio.google.com/apikey

> ⚠️ Meta has **no native scheduling for Reels**. ReelHub holds the schedule and publishes at the due time.

---

## Backup & Restore

Backups run automatically every 6 hours (encrypted with AES-256-GCM).

**Manual backup:**
```bash
curl -X POST http://localhost:3000/api/v1/system/backups \
  -H "Cookie: session=<your-session>"
```

**Restore & Disaster Recovery Drill:**
```bash
# 1. Stop core
docker compose -p reelhub stop core

# 2. Run automated restore CLI (decrypts, validates PRAGMA integrity_check, backs up target, and restores)
export MASTER_KEY="<your-32-byte-hex-key>"
pnpm --filter @reelhub/core restore /srv/reelhub/backups/backup_<TIMESTAMP>.sqlite.enc /srv/reelhub/db/reelhub.sqlite

# 3. Restart
docker compose -p reelhub start core
```
See full runbook at [`docs/DISASTER_RECOVERY.md`](docs/DISASTER_RECOVERY.md).

Target RTO ≤ 30 minutes; RPO ≤ 6 hours (default backup interval).

---

## Updates

```bash
# 1. Pull new images / rebuild
docker compose -p reelhub build core

# 2. Apply migrations (automatic on startup; backup taken first)
docker compose -p reelhub up -d core

# Roll back: restore previous image tag + pre-migration backup
```

---

## Rollback

```bash
docker compose -p reelhub down
# (data in /srv/reelhub/ is untouched — bind mounts are not removed by Docker)
# Remove the reverse proxy virtual-host entry and reload the proxy
```

---

## Development

```bash
# Install dependencies
pnpm install

# Run all services in dev mode
pnpm dev

# Type check
pnpm typecheck

# Build all packages
pnpm build
```

