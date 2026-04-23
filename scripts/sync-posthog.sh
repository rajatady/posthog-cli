#!/usr/bin/env bash
# Sync the pinned PostHog monorepo into ./posthog/.
# Reads POSTHOG_SHA from the repo root. Shallow-clones if absent, checks out the pin.
# Run this before `npm run build:extract`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SHA="$(cat POSTHOG_SHA | tr -d '[:space:]')"
[[ -z "$SHA" ]] && { echo "POSTHOG_SHA is empty" >&2; exit 1; }

if [[ ! -d posthog/.git ]]; then
    echo "cloning PostHog monorepo (partial, blobless) ..." >&2
    git clone --filter=blob:none https://github.com/PostHog/posthog.git posthog
fi

cd posthog
git fetch --depth=1 origin "$SHA" 2>/dev/null || git fetch origin
git checkout -q "$SHA"
echo "posthog pinned at $(git rev-parse --short HEAD)" >&2
