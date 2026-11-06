#!/usr/bin/env bash
# Local Cloudflare Pages deploy for opctrip01, run from the operator's machine.
#
# Replaces .github/workflows/deploy.yml (removed 2026-11-05, owner decision:
# no GitHub Actions and no runners).
#
# Usage: scripts/deploy.sh <production|preview>
#   production  pnpm install, pnpm check, pnpm build, pnpm build:worker
#               (bundles functions/_worker.ts into dist/public/_worker.js),
#               wrangler d1 migrations apply opctrip01 --remote
#               (drizzle/migrations), then
#               wrangler pages deploy dist/public --project-name=opctrip01.
#               Refuses unless the tree is clean and HEAD == origin/main.
#   preview     same build without `pnpm check` and without migrations,
#               deployed with --branch=preview. Preview deployments use the
#               same D1/KV bindings as production.
#               Refuses unless the tree is clean and HEAD == origin/<branch>,
#               i.e. the commit being previewed is on GitHub.
#
# Environment (same names as the workflow secrets):
#   required  CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,
#             CLOUDFLARE_D1_DATABASE_ID (from `wrangler d1 list`),
#             CLOUDFLARE_SESSION_KV_ID (from `wrangler kv namespace list`)
#   build     VITE_OAUTH_PORTAL_URL, VITE_APP_ID (baked into the client)
# Unset build values are passed as empty. The Worker's runtime secrets
# (JWT_SECRET, OAUTH_SERVER_URL, VITE_APP_ID, OWNER_OPEN_ID) are Pages
# secrets, set once with `wrangler pages secret put NAME
# --project-name=opctrip01`; they are not needed here.
# wrangler.toml holds ${...} placeholders for the D1 and KV ids (wrangler does
# not expand them); they are filled in only inside the throwaway export.
# Wrangler reads CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID from the
# environment, so no secret is put on argv, echoed or written to disk.
#
# The build runs in a pristine `git archive` export of HEAD (what
# actions/checkout produced), never in the working copy.

set -euo pipefail

readonly DEFAULT_BRANCH=main
readonly PROJECT_NAME=opctrip01
readonly D1_DATABASE=opctrip01
readonly NODE_MAJOR_EXPECTED=20
readonly PNPM_VERSION_EXPECTED=10.4.1

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$ROOT"

log() { printf '==> %s\n' "$*" >&2; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,/^$/{s/^# \{0,1\}//;p}' "${BASH_SOURCE[0]}" >&2
  exit "${1:-2}"
}

require_env() {
  local name missing=()
  for name in "$@"; do
    [ -n "${!name:-}" ] || missing+=("$name")
  done
  [ "${#missing[@]}" -eq 0 ] || die "missing required environment variable(s): ${missing[*]}"
}

warn_unset() {
  local name
  for name in "$@"; do
    [ -n "${!name:-}" ] || warn "$name is not set; passing it empty"
  done
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not on PATH"
}

# Trigger guard: production ran on push to main; preview on pull requests.
# Fill the wrangler.toml binding placeholders in the export only.
fill_bindings() {
  local config="$SRC/wrangler.toml"
  [[ "$CLOUDFLARE_D1_DATABASE_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] \
    || die "CLOUDFLARE_D1_DATABASE_ID is not a D1 database UUID"
  [[ "$CLOUDFLARE_SESSION_KV_ID" =~ ^[0-9a-f]{32}$ ]] \
    || die "CLOUDFLARE_SESSION_KV_ID is not a KV namespace id (32 hex characters)"
  # shellcheck disable=SC2016 # literal placeholders, not expansions
  if ! grep -qF '${CLOUDFLARE_D1_DATABASE_ID}' "$config" \
    || ! grep -qF '${CLOUDFLARE_SESSION_KV_ID}' "$config"; then
    die "wrangler.toml no longer has the expected binding placeholders"
  fi
  sed -i.bak \
    -e "s/\\\${CLOUDFLARE_D1_DATABASE_ID}/$CLOUDFLARE_D1_DATABASE_ID/" \
    -e "s/\\\${CLOUDFLARE_SESSION_KV_ID}/$CLOUDFLARE_SESSION_KV_ID/" \
    "$config"
  rm -f "$config.bak"
  # shellcheck disable=SC2016
  ! grep -qF '${' "$config" || die "unfilled placeholder left in wrangler.toml"
}

guard_synced_with_origin() {
  local branch="$1" remote head
  log "checking working tree and origin/$branch"
  git fetch --quiet origin "$branch"
  remote="$(git rev-parse FETCH_HEAD)"
  head="$(git rev-parse HEAD)"
  [ -z "$(git status --porcelain)" ] \
    || die "working tree is not clean; commit or stash first"
  [ "$head" = "$remote" ] \
    || die "HEAD ($head) != origin/$branch ($remote); push first, deploy only what is on GitHub"
  DEPLOY_SHA="$head"
  COMMIT_SUBJECT="$(git log -1 --format=%s "$head")"
  log "deploying $DEPLOY_SHA"
}

check_toolchain() {
  require_cmd node
  require_cmd pnpm
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" = "$NODE_MAJOR_EXPECTED" ] \
    || warn "the workflow used Node $NODE_MAJOR_EXPECTED; this machine has Node $(node --version)"
  # package.json pins pnpm@10.4.1 via packageManager; pnpm 10 switches to it.
  log "node $(node --version), pnpm $(cd "$SRC" && pnpm --version) (workflow: pnpm $PNPM_VERSION_EXPECTED)"
}

WORK=""
cleanup() { [ -z "$WORK" ] || rm -rf "$WORK"; }
trap cleanup EXIT

export_tree() {
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/opctrip-deploy.XXXXXX")"
  SRC="$WORK/src"
  mkdir "$SRC"
  git archive --format=tar "$DEPLOY_SHA" | tar -x -C "$SRC"
}

build() {
  local with_check="$1"
  cd "$SRC"
  pnpm install --no-frozen-lockfile
  if [ "$with_check" = 1 ]; then
    pnpm check
  fi
  VITE_OAUTH_PORTAL_URL="${VITE_OAUTH_PORTAL_URL:-}" VITE_APP_ID="${VITE_APP_ID:-}" \
    pnpm build
  pnpm build:worker
  [ -s dist/public/_worker.js ] || die "build:worker did not produce dist/public/_worker.js"
  [ -s dist/public/_routes.json ] || die "dist/public/_routes.json is missing"
}

main() {
  [ "$#" -eq 1 ] || usage
  local target="$1" branch
  case "$target" in
    -h|--help) usage 0 ;;
    production) branch="$DEFAULT_BRANCH" ;;
    preview)
      branch="$(git symbolic-ref --quiet --short HEAD)" \
        || die "preview needs a checked-out branch (HEAD is detached)"
      ;;
    *) printf 'error: unknown target: %s\n\n' "$target" >&2; usage ;;
  esac

  require_cmd git
  require_env CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID \
    CLOUDFLARE_D1_DATABASE_ID CLOUDFLARE_SESSION_KV_ID
  warn_unset VITE_OAUTH_PORTAL_URL VITE_APP_ID
  export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID

  guard_synced_with_origin "$branch"
  export_tree
  fill_bindings
  check_toolchain

  if [ "$target" = production ]; then
    build 1
    # Migrate before the new code goes live. The migrations are additive
    # (CREATE ... IF NOT EXISTS); a failure stops the deploy with the old
    # deployment still serving. CI=true skips wrangler's confirmation prompt.
    log "wrangler: d1 migrations apply $D1_DATABASE --remote"
    CI=true pnpm exec wrangler d1 migrations apply "$D1_DATABASE" --remote
    log "wrangler: pages deploy dist/public --project-name=$PROJECT_NAME"
    # The export has no .git, so pass the branch and commit explicitly.
    pnpm exec wrangler pages deploy dist/public --project-name="$PROJECT_NAME" \
      --branch="$DEFAULT_BRANCH" --commit-hash="$DEPLOY_SHA" --commit-message="$COMMIT_SUBJECT"
  else
    build 0
    log "wrangler: pages deploy dist/public --project-name=$PROJECT_NAME --branch=preview"
    pnpm exec wrangler pages deploy dist/public --project-name="$PROJECT_NAME" \
      --branch=preview --commit-hash="$DEPLOY_SHA" --commit-message="$COMMIT_SUBJECT"
  fi
  log "done: $target"
}

main "$@"
