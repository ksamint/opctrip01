# Cloudflare Deployment Guide for opctrip01

## Prerequisites

1. **Cloudflare Account** with Pages and D1 enabled
2. **Wrangler CLI** installed: `npm i -g wrangler`
3. **pnpm 10** and **Node 20** on the operator's machine (deploys run locally; there is no CI/CD)

## Initial Setup

### 1. Create the D1 database and KV namespace

```bash
wrangler d1 create opctrip01
wrangler kv namespace create SESSION_KV
```

Keep the two ids for the deploy environment below. Do not write them into `wrangler.toml`:
it holds `${CLOUDFLARE_D1_DATABASE_ID}` / `${CLOUDFLARE_SESSION_KV_ID}` placeholders, which
wrangler does not expand. `scripts/deploy.sh` fills them in inside its throwaway export.

### 2. D1 migrations

Migrations live in `drizzle/migrations/` (`migrations_dir` in `wrangler.toml`). They are
additive (`CREATE ... IF NOT EXISTS`). `pnpm run deploy` applies them to the remote database
before the new code goes live; run them by hand with `pnpm db:migrate:cf` (remote) or
`wrangler d1 migrations apply opctrip01 --local` for local development.

### 3. Set the Worker's runtime secrets

These are Pages project secrets, read by `functions/_worker.ts` at runtime:

```bash
wrangler pages secret put JWT_SECRET --project-name=opctrip01       # min 32 characters
wrangler pages secret put OAUTH_SERVER_URL --project-name=opctrip01
wrangler pages secret put VITE_APP_ID --project-name=opctrip01
wrangler pages secret put OWNER_OPEN_ID --project-name=opctrip01
```

### 4. Deploy Environment

Deploys run from the operator's machine (no GitHub Actions, owner decision 2026-11-05).
Export these in the shell that runs `scripts/deploy.sh`; never commit them:

- `CLOUDFLARE_API_TOKEN` - From Cloudflare dashboard (required; Pages and D1 edit)
- `CLOUDFLARE_ACCOUNT_ID` - Your Cloudflare account ID (required)
- `CLOUDFLARE_D1_DATABASE_ID` - D1 database UUID from `wrangler d1 list` (required)
- `CLOUDFLARE_SESSION_KV_ID` - KV namespace id from `wrangler kv namespace list` (required)
- `VITE_APP_ID` - App ID, baked into the client build
- `VITE_OAUTH_PORTAL_URL` - OAuth portal URL (for login redirect), baked into the client build

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
`git archive` export of `HEAD` it runs `pnpm install --no-frozen-lockfile`, `pnpm check`
(app and Worker), `pnpm build`, `pnpm build:worker` (bundles `functions/_worker.ts` into
`dist/public/_worker.js`; `client/public/_routes.json` sends only `/api/*` to it, so static
files and SPA routes are served by Pages), `wrangler d1 migrations apply opctrip01 --remote`,
then `wrangler pages deploy dist/public --project-name=opctrip01 --branch=main`. A failed
migration stops the deploy while the previous deployment keeps serving.

### Preview

```bash
pnpm run deploy:preview    # = scripts/deploy.sh preview
```

Run from a pushed feature branch (clean tree, `HEAD` equals `origin/<branch>`). Same build without
`pnpm check`, deployed with `--branch=preview` to `https://preview.opctrip01.pages.dev`. Preview
does not run migrations and uses the same D1/KV bindings as production.

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
│   ├── _worker.ts      # Hono + tRPC API server (bundled to dist/public/_worker.js)
│   └── tsconfig.json   # Worker typecheck (part of `pnpm check`)
├── drizzle/            # Database schema & migrations
│   ├── cf-schema.ts    # Cloudflare D1 (SQLite) schema
│   └── migrations/     # SQL migrations
├── client/             # React frontend (Vite)
├── scripts/deploy.sh   # Local deploy (production / preview)
└── wrangler.toml       # Cloudflare config
```
