#!/usr/bin/env bash
# Local Cloudflare Pages deploy for opctrip01, run from the operator's machine.
#
# Replaces .github/workflows/deploy.yml (removed 2026-11-05, owner decision:
# no GitHub Actions and no runners).
#
# Usage: scripts/deploy.sh <production|preview>
#   production  the workflow's `deploy` job (push to main): pnpm install,
#               pnpm check, pnpm build, pnpm build:worker,
#               wrangler pages deploy dist/public --project-name=opctrip01,
#               wrangler d1 migrations apply opctrip01 --local.
#               Refuses unless the tree is clean and HEAD == origin/main.
#   preview     the workflow's `preview` job (pull requests): same build
#               without `pnpm check`, deployed with --branch=preview.
#               Refuses unless the tree is clean and HEAD == origin/<branch>,
#               i.e. the commit being previewed is on GitHub.
#
# Environment (same names as the workflow secrets):
#   required  CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
#   build     VITE_OAUTH_PORTAL_URL, VITE_APP_ID
#   worker    JWT_SECRET, OAUTH_SERVER_URL, VITE_APP_ID, OWNER_OPEN_ID
# Unset build/worker values are passed as empty, as GitHub did for unset
# secrets. Wrangler reads CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID from the
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
  JWT_SECRET="${JWT_SECRET:-}" OAUTH_SERVER_URL="${OAUTH_SERVER_URL:-}" \
    VITE_APP_ID="${VITE_APP_ID:-}" OWNER_OPEN_ID="${OWNER_OPEN_ID:-}" \
    pnpm build:worker
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
  require_env CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
  warn_unset VITE_OAUTH_PORTAL_URL VITE_APP_ID JWT_SECRET OAUTH_SERVER_URL OWNER_OPEN_ID
  export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID

  guard_synced_with_origin "$branch"
  export_tree
  check_toolchain

  if [ "$target" = production ]; then
    build 1
    log "wrangler: pages deploy dist/public --project-name=$PROJECT_NAME"
    # The runner checked out main, so wrangler sent branch=main; the export
    # has no .git, so pass the branch and commit explicitly.
    pnpm exec wrangler pages deploy dist/public --project-name="$PROJECT_NAME" \
      --branch="$DEFAULT_BRANCH" --commit-hash="$DEPLOY_SHA" --commit-message="$COMMIT_SUBJECT"
    # Kept from the workflow as-is: --local applies the migrations to the
    # throwaway local D1 state in the export dir, not to the remote database.
    # CI=true keeps wrangler non-interactive, as it was on the runner.
    log "wrangler: d1 migrations apply $D1_DATABASE --local"
    CI=true pnpm exec wrangler d1 migrations apply "$D1_DATABASE" --local
  else
    build 0
    log "wrangler: pages deploy dist/public --project-name=$PROJECT_NAME --branch=preview"
    pnpm exec wrangler pages deploy dist/public --project-name="$PROJECT_NAME" \
      --branch=preview --commit-hash="$DEPLOY_SHA" --commit-message="$COMMIT_SUBJECT"
  fi
  log "done: $target"
}

main "$@"
