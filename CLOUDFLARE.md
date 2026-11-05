# Cloudflare Deployment Guide for opctrip01

## Prerequisites

1. **Cloudflare Account** with Pages and D1 enabled
2. **Wrangler CLI** installed: `npm i -g wrangler`
3. **pnpm 10** and **Node 20** on the operator's machine (deploys run locally; there is no CI/CD)

## Initial Setup

### 1. Create D1 Database

```bash
wrangler d1 create opctrip01
```

Note the `database_id` from the output and update `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "opctrip01"
database_id = "YOUR_DATABASE_ID_HERE"
```

### 2. Run D1 Migrations

```bash
wrangler d1 migrations apply opctrip01 --local
```

### 3. Set Secrets

```bash
wrangler secret put JWT_SECRET
# Enter your JWT secret (min 32 characters)

wrangler secret put OAUTH_SERVER_URL
# Enter your OAuth server URL

wrangler secret put VITE_APP_ID
# Enter your App ID

wrangler secret put OWNER_OPEN_ID
# Enter the OpenID of the owner/admin user
```

### 4. Deploy Environment

Deploys run from the operator's machine (no GitHub Actions, owner decision 2026-11-05).
Export these in the shell that runs `scripts/deploy.sh`; never commit them:

- `CLOUDFLARE_API_TOKEN` - From Cloudflare dashboard (required)
- `CLOUDFLARE_ACCOUNT_ID` - Your Cloudflare account ID (required)
- `JWT_SECRET` - Your JWT secret
- `OAUTH_SERVER_URL` - OAuth server URL
- `VITE_APP_ID` - App ID
- `OWNER_OPEN_ID` - Owner OpenID
- `VITE_OAUTH_PORTAL_URL` - OAuth portal URL (for login redirect)

## Local Development

```bash
# Install dependencies
pnpm install

# Start local development server
pnpm dev

# Build for Cloudflare
pnpm build:cf

# Test locally with Cloudflare
pnpm start:cf
```

## Deployment

### Production

```bash
pnpm run deploy            # = scripts/deploy.sh production
```

Refuses unless the working tree is clean and `HEAD` equals `origin/main`. In a clean
`git archive` export of `HEAD` it runs `pnpm install --no-frozen-lockfile`, `pnpm check`,
`pnpm build`, `pnpm build:worker`, `wrangler pages deploy dist/public --project-name=opctrip01
--branch=main`, then `wrangler d1 migrations apply opctrip01 --local` (local state only; it does
not migrate the remote D1 database).

### Preview

```bash
pnpm run deploy:preview    # = scripts/deploy.sh preview
```

Run from a pushed feature branch (clean tree, `HEAD` equals `origin/<branch>`). Same build without
`pnpm check`, deployed with `--branch=preview` to `https://preview.opctrip01.pages.dev`.

Use `pnpm run deploy`, not `pnpm deploy` (that is pnpm's built-in `deploy` command).

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `JWT_SECRET` | Session token signing secret | Yes |
| `OAUTH_SERVER_URL` | Manus OAuth server URL | Yes |
| `VITE_APP_ID` | OAuth App ID | Yes |
| `OWNER_OPEN_ID` | Admin user's OpenID | Yes |
| `VITE_OAUTH_PORTAL_URL` | OAuth portal for login | Yes |

## Project Structure

```
├── functions/          # Cloudflare Pages Functions
│   └── _worker.ts      # Hono + tRPC API server
├── drizzle/            # Database schema & migrations
│   ├── cf-schema.ts    # Cloudflare D1 (SQLite) schema
│   └── migrations/     # SQL migrations
├── client/             # React frontend (Vite)
├── scripts/deploy.sh   # Local deploy (production / preview)
└── wrangler.toml       # Cloudflare config
```
