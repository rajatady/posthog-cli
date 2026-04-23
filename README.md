# thehogcli

A PostHog CLI that mirrors the PostHog MCP tool surface — without the ~250,000-token schema dump agents pay just to register the MCP before the first useful call.

```bash
npm install -g thehogcli
thehogcli login
thehogcli feature-flags feature-flag-get-all --why "check active flags" --limit 5
```

## Why

PostHog's hosted MCP exposes **262 tools**. Every MCP client preloads that schema into context at startup. For coding agents (Claude Code, Cursor, Codex), that's a quarter-million tokens burned *before your first query*. The CLI hits the same PostHog REST endpoints that the MCP wraps, but exposes them as plain subcommands an agent invokes on demand. An optional one-file Claude Code skill gives the agent just enough context to discover commands via `--help`.

Every executed query is captured locally in `.thehogcli/history.db` — keyed by a UUID, annotated with a required `--why`, and re-runnable by id. Context loss doesn't erase your work.

## Features

- **262 tools** across 38 modules, auto-discovered from the PostHog MCP registry
- **OAuth 2.0 Authorization Code + PKCE** with Dynamic Client Registration — same flow MCP uses
- **72 scopes derived automatically** from the tool registry; no hand-maintained scope list
- **Project auto-discovery** via `@current` server-side alias; no "select your project" prompt
- **Local query history** in SQLite with `thehogcli history {list,show}` and required `--why` annotations
- **`--dry-run`** resolves the full HTTP request without sending it, for auditing
- **Auto token refresh** on 401 when refresh tokens are available
- **Zero MCP connection** — standalone CLI, ~138 kB tarball

## Quick start

```bash
npm install -g thehogcli

# one-time: browser-based OAuth login
thehogcli login

# top-level help: 38 modules
thehogcli --help

# drill into a module
thehogcli feature-flags --help

# run a tool — --why is required, stored in history
thehogcli feature-flags feature-flag-get-all --why "quick flag audit" --limit 5

# dynamic queries via HogQL
thehogcli sql execute-sql --why "event count last hour" \
  --query "SELECT count() FROM events WHERE timestamp > now() - INTERVAL 1 HOUR"

# history
thehogcli history                            # paginated list
thehogcli history show <id-prefix>           # full entry

# utility commands
thehogcli whoami                             # host, project, masked token, expiry
thehogcli projects                           # list projects you can access
thehogcli use <projectId>                    # pin a specific project
thehogcli scopes [--read-only]               # preview scopes before login
```

## Environment variables

All optional; OAuth login stores equivalents in `~/.thehogcli/config.json`.

```bash
POSTHOG_CLI_HOST=https://us.posthog.com       # or https://eu.posthog.com, or self-hosted
POSTHOG_CLI_API_KEY=<personal-api-key>        # PAT; bypasses OAuth flow
POSTHOG_CLI_PROJECT_ID=<numeric-id>           # override server-side @current
POSTHOG_CLI_ORG_ID=<uuid>                     # override organization
THEHOGCLI_NET_FAMILY=4                        # IPv4-only (default; fixes Node happy-eyeballs bugs)
THEHOGCLI_CONNECT_TIMEOUT_MS=30000            # connect timeout
THEHOGCLI_HISTORY_DB=<abs-path>               # override .thehogcli/history.db location
```

## How it stays in sync with PostHog

`POSTHOG_SHA` pins a commit of the [PostHog monorepo](https://github.com/PostHog/posthog). The extractor (`build/extract.ts`) walks `posthog/services/mcp/` — the MCP's own codegen output — and distills it into `src/registry.json` that ships with the package.

**End users never need the PostHog monorepo.** The shipped package is standalone (~138 kB gzipped). Bumping the pin is a maintainer-only workflow.

### Maintainer workflow

```bash
git clone git@github.com:rajatady/posthog-cli.git
cd posthog-cli
npm install
npm run sync:posthog           # blobless clone of PostHog monorepo (~500 MB)
npm run build:extract          # distill registry.json
npm run build                  # extract + compile
npm test                       # 34 tests
```

To bump: edit `POSTHOG_SHA`, re-run `npm run sync:posthog && npm run build && npm test`, commit, publish.

## Architecture

```
posthog-cli/
├── POSTHOG_SHA                    # pinned PostHog commit
├── scripts/sync-posthog.sh        # clones/checks out the pin (dev + CI only)
├── build/extract.ts               # posthog/services/mcp → src/registry.json
├── src/
│   ├── index.ts                   # CLI entry — builds commander tree from registry
│   ├── registry.json              # 262 tools in a normalized form (shipped)
│   ├── commands/
│   │   ├── login.ts               # OAuth code+PKCE, DCR, projects, use, scopes, whoami
│   │   ├── tool.ts                # generic tool executor (http-spec'd + handwritten v1)
│   │   └── history.ts             # list, show (rerun + fork pending)
│   └── lib/
│       ├── api.ts                 # fetch wrapper, @current resolution, auto-refresh
│       ├── oauth.ts               # authorization code + PKCE + DCR + refresh
│       ├── discover.ts            # project/org auto-pick (mirrors MCP StateManager)
│       ├── scopes.ts              # union of every tool.scopes in registry
│       ├── config.ts              # env vars + ~/.thehogcli/config.json
│       ├── history.ts             # SQLite history
│       └── net.ts                 # IPv4-only undici dispatcher
└── tests/                         # vitest: extractor, CLI registration, scopes, history
```

## What's deliberately pending

- `thehogcli history rerun <id>` / `history fork <id>` — stubs, print a message
- Destructive-op confirmation flag — warns, doesn't prompt
- Per-field flags for 14 handwritten tools (`query-trends`, `query-funnel`, etc.) — fall back to `--args '<json>'`
- Proactive token refresh before expiry (refreshes on 401 only)
- Shell completions (bash/zsh/fish)

## License

MIT © Kumar Divya Rajat
