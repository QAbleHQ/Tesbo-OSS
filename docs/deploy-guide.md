# Tesbo Test Manager DigitalOcean Deploy Guide

This guide covers the first public release: the core test case management platform.

## Architecture

| Component | Target | Port |
|-----------|--------|------|
| Frontend | Droplet with Nginx + Docker Compose | 443 -> Nginx -> 127.0.0.1:3000 |
| Backend | Droplet with Nginx + Docker Compose | 443 -> Nginx -> 127.0.0.1:7000 |
| PostgreSQL | Managed database or self-hosted PostgreSQL | 5432 |

All images are stored in DigitalOcean Container Registry (DOCR).

Each droplet runs Nginx as a reverse proxy with Let's Encrypt SSL certificates. Docker containers bind to localhost only. The deploy workflow handles Nginx and Certbot setup through `deploy/nginx/setup-ssl.sh`.

## Workflow

Manual trigger:

```text
.github/workflows/deploy.yml
```

## Required GitHub Secrets

| Secret | Description |
|--------|-------------|
| `DO_API_TOKEN` | DigitalOcean API token |
| `DOCR_REGISTRY` | e.g. `registry.digitalocean.com/your-registry` |
| `DOCR_REPO_FRONTEND` | Frontend image repo name |
| `DOCR_REPO_BACKEND` | Backend image repo name |
| `DROPLET_FRONTEND_IP` | Frontend droplet IP |
| `DROPLET_BACKEND_IP` | Backend droplet IP |
| `SSH_PRIVATE_KEY` | SSH key for droplet access |
| `NEXT_PUBLIC_API_URL` | Public backend URL, e.g. `https://api.example.com` |
| `FRONTEND_DOMAIN` | Frontend domain |
| `BACKEND_DOMAIN` | Backend domain |
| `CERTBOT_EMAIL` | Email for Let's Encrypt certificate notifications |

Backend runtime secrets:

- `DATABASE_URL`, `DATABASE_USER`, `DATABASE_PASSWORD`
- `CORS_ALLOWED_ORIGINS`
- `FRONTEND_URL`, `SESSION_DAYS`
- `POSTMARK_API_TOKEN`, `POSTMARK_FROM_EMAIL`
- `JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET`, `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET` — platform OAuth apps (see [Jira / Linear OAuth](#jira--linear-oauth) below)
- `JIRA_REDIRECT_URI`, `LINEAR_REDIRECT_URI` — optional; default to `FRONTEND_URL` + `/integrations/callback`
- `UPLOAD_DIR`, `MAX_UPLOAD_SIZE`
- `STORAGE_DRIVER`, `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `S3_PRESIGNED_URL_TTL_SECONDS` (see [Knowledge Base File Storage](#knowledge-base-file-storage) below)

## Jira / Linear OAuth

Register **one** OAuth app per provider for the whole deployment, put its credentials in the backend
env, and every workspace owner connects by clicking **Connect** — they never see or enter a client
id, client secret, or callback URL.

**Jira** — in the [Atlassian Developer Console](https://developer.atlassian.com/console/myapps/):

1. Create an app and add the **OAuth 2.0 (3LO)** authorization type.
2. Set the callback URL to `FRONTEND_URL` + `/integrations/callback`
   (e.g. `https://app.example.com/integrations/callback`).
3. Under Permissions → Jira API, add the scopes
   `read:jira-work`, `read:jira-user`, `write:jira-work`, `offline_access`.
4. Copy the Client ID and Secret into `JIRA_CLIENT_ID` / `JIRA_CLIENT_SECRET`.

**Linear** — Settings → API → OAuth applications: same callback URL, then
`LINEAR_CLIENT_ID` / `LINEAR_CLIENT_SECRET`.

Notes:

- **This is the only way to configure it.** There is no per-workspace OAuth app and no personal
  access token option — if the client id/secret aren't set, the Integrations page tells the workspace
  owner to ask whoever runs the instance, and Connect stays unavailable. Self-hosted installs use the
  exact same flow with their own app's credentials.
- `*_REDIRECT_URI` only needs setting when the callback must differ from `FRONTEND_URL` — for
  example a proxy that terminates on another host. Whatever value is used must match the provider
  console exactly.
- `SECRETS_ENCRYPTION_KEY` must be set: it encrypts the OAuth tokens at rest and derives the key
  that signs the OAuth `state`. Rotating it invalidates stored tokens, so workspaces must reconnect.
- **Jira Server / Data Center is not supported** — cloud OAuth via `auth.atlassian.com` requires a
  Jira Cloud site. Only `*.atlassian.net`-style cloud instances can be connected.

## Knowledge Base File Storage

Files uploaded to the project Knowledge Base are stored via a pluggable backend, controlled by `STORAGE_DRIVER`:

| `STORAGE_DRIVER` | Behavior |
|---|---|
| `local` (default) | Files are saved to disk under `UPLOAD_DIR` (`/app/uploads` in the container, mounted to a volume in both `docker-compose.yml` and `deploy/Tesbo-Backend/docker-compose.yml`). No further setup needed — this is fine for a single backend instance. |
| `s3` | Files are stored in an S3-compatible bucket instead. Works with real AWS S3 as well as DigitalOcean Spaces, MinIO, Cloudflare R2, Backblaze B2, or anything else that speaks the S3 API. |

To enable S3-compatible storage, set:

- `STORAGE_DRIVER=s3`
- `S3_BUCKET` — the bucket name (required)
- `S3_REGION` — defaults to `us-east-1`; some providers ignore this but the SDK still requires a value
- `S3_ENDPOINT` — only needed for non-AWS providers (e.g. `https://nyc3.digitaloceanspaces.com` for DO Spaces, or your MinIO URL). Leave blank for real AWS S3.
- `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` — leave both blank to fall back to the default AWS credential chain (IAM role, instance profile, shared config) instead of static keys
- `S3_FORCE_PATH_STYLE=true` — required by MinIO and some other S3-compatible services; leave `false` for AWS S3 and most others
- `S3_PRESIGNED_URL_TTL_SECONDS` — how long a generated download/preview link stays valid (default `300`)

Files are stored under a per-project key prefix (`knowledge-base/<projectId>/...`), and are never served as public/durable links — every download or preview request is checked against the requesting user's project membership and role first, and only then is a short-lived presigned URL issued (or, in local mode, the file is streamed directly). Switching `STORAGE_DRIVER` does not migrate files already stored under the previous driver.

## Deploy Flow

1. Add or update all GitHub secrets.
2. Trigger **Deploy Tesbo Test Manager to DigitalOcean** from GitHub Actions.
3. The workflow builds and pushes frontend and backend images with `sha` and `latest` tags.
4. The workflow deploys each image to its droplet through SSH and Docker Compose.

## Droplet Prep

Run once per droplet:

```bash
curl -fsSL https://get.docker.com | sh
```

Open firewall ports: `22`, `80`, `443`.

## DNS Setup

Point each domain to the corresponding droplet IP as a plain A record.

| Record | Type | Value | Proxy |
|--------|------|-------|-------|
| `app.example.com` | A | `<FRONTEND_IP>` | DNS only |
| `api.example.com` | A | `<BACKEND_IP>` | DNS only |

## Verification

- Frontend: `https://app.example.com/`
- Backend health: `https://api.example.com/health`
