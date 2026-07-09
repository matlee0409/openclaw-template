# openclaw-railway

A Node.js/Express management wrapper for [OpenClaw](https://github.com/openclaw/openclaw) — an open-source, self-hosted AI assistant. This wrapper provides a setup wizard (`/setup`), an admin dashboard (`/admin`), live terminal access, a proxy to the OpenClaw gateway, and **optional GitHub-backed persistence** for all user data.

## Stack

- **Runtime**: Node.js ≥ 22 (ESM)
- **Server**: Express 4
- **Key deps**: `ws` (WebSocket), `node-pty` (terminal), `http-proxy` (gateway proxy), `chokidar` (file watching)
- **Deployment target**: Railway (Docker-based)

## Project structure

```
src/
  server.js               # Entry point — Express app + WebSocket upgrade handler
  config/index.js         # All env vars and path constants
  routes/
    setup.js              # Setup wizard routes (incl. GitHub save logic)
    api.js                # Internal management API
    github.js             # GitHub backup API (/api/github/*)
  services/
    gatewayManager.js     # Starts/stops the OpenClaw gateway process
    pairingService.js     # Device pairing (SSE + SDK)
    terminalService.js    # PTY terminal over WebSocket
    gitSyncService.js     # GitHub backup — verify, init, sync, auto-sync
  middleware/
    auth.js               # Admin password cookie auth
    proxy.js              # Reverse proxy to OpenClaw gateway
    logger.js             # Request logging
  utils/
public/
  setup.html              # Setup wizard UI (includes GitHub backup card)
  admin.html              # Admin dashboard UI
Dockerfile                # Two-stage build; installs openclaw globally
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | No (default 3000) | Public-facing port (Railway sets automatically) |
| `WRAPPER_ADMIN_PASSWORD` | Recommended | Password for `/admin` and `/api` endpoints |
| `OPENCLAW_GATEWAY_TOKEN` | Recommended | Token for OpenClaw's own auth layer |
| `OPENCLAW_DATA_DIR` | No (default `/data`) | Volume mount path for persistent state |
| `OLLAMA_BASE_URL` | No | Pre-fill Ollama URL in setup wizard |
| `OPENCLAW_ENTRY` | No | Path to openclaw's `entry.js` |
| `OPENCLAW_VERSION` | No (build arg) | Pin openclaw version (default `2026.6.6`) |
| `GITHUB_TOKEN` | No | GitHub PAT for backup (set via setup wizard or directly) |
| `GITHUB_WORKSPACE_REPO` | No | Target repo as `owner/name` (set via setup wizard or directly) |

## GitHub Backup Feature

The setup wizard has a **GitHub Backup** card where users can provide:
- A GitHub personal access token (classic PAT with `repo` scope, or fine-grained with Contents read/write + Metadata read)
- A target repo in `owner/name` format

On setup completion:
1. The token and repo are verified against the GitHub API
2. A private repo is created if it doesn't exist, or the existing repo is verified
3. `/data/.openclaw` is initialized as a git repo with an opinionated `.gitignore`
4. An initial commit is pushed
5. Hourly auto-sync starts (commit + push `/data/.openclaw` changes every hour)

If `GITHUB_TOKEN` and `GITHUB_WORKSPACE_REPO` env vars are already set when the server starts, the auto-sync starts immediately without needing the setup wizard.

### GitHub API routes

| Endpoint | Auth | Description |
|---|---|---|
| `POST /api/github/verify` | None | Verify token + repo (called pre-setup) |
| `GET /api/github/status` | Admin | Current sync status and last sync result |
| `POST /api/github/sync` | Admin | Trigger a manual sync immediately |

### What gets synced

The `.gitignore` in `/data/.openclaw` whitelists only safe, non-sensitive files:
- `openclaw.json` (gateway config)
- `workspace/` (prompts, skills, agent configs)
- `.gitignore`

Excluded: `db/`, runtime state, node modules, etc.

## Running on Railway

1. Deploy via the Railway template button in the README.
2. Open the service URL — it redirects to `/setup` automatically.
3. Complete the setup wizard (pick AI provider, paste API key, optionally configure messaging channels and GitHub backup).
4. Access `/admin` with your `WRAPPER_ADMIN_PASSWORD`.

## Running locally (Docker)

```bash
docker build -t openclaw-railway .
docker run -p 3000:3000 \
  -e WRAPPER_ADMIN_PASSWORD=yourpassword \
  -e OPENCLAW_GATEWAY_TOKEN=your-token \
  -e GITHUB_TOKEN=ghp_... \
  -e GITHUB_WORKSPACE_REPO=your-username/openclaw-backup \
  -v ./data:/data \
  openclaw-railway
```

## User preferences
