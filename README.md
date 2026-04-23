# thehogcli

A PostHog CLI that mirrors the PostHog MCP tool surface — without the 250k-token schema dump agents pay just to say hello when the MCP is connected.

## Why

PostHog MCP exposes ~262 tools. Every MCP client that registers it preloads the full schema into context on startup. For coding agents (Claude Code, Cursor, Codex), that's a quarter-million tokens burned before the first real query.

`thehogcli` hits the same PostHog REST endpoints that the MCP wraps, but exposes them as plain CLI subcommands. Agents (or humans) invoke it on demand. A <1 KB companion skill (`thehogcli.skill.md`) is all the context an agent needs to learn the pattern.

Every executed query is captured locally in `.thehogcli/history.db` — keyed by a UUID, annotated with a required `--description`, and re-runnable by id. Context loss doesn't erase your work.

## Status

Scaffold. Early. Not publishable yet.

## How it stays in sync with PostHog

`POSTHOG_SHA` pins a commit of the [PostHog monorepo](https://github.com/PostHog/posthog). `scripts/sync-posthog.sh` shallow-clones that pin into `posthog/` (gitignored). The extractor (`build/extract.ts`) walks `posthog/services/mcp/src/{generated,tools/generated}` — the MCP's own codegen output — and distills it into a compact `src/registry.json` that ships with the npm package.

Bumping the pin is a one-line change + extractor rerun + tests.

(Converting `posthog/` to a proper git submodule is a follow-up once the pin cadence stabilizes.)

## Layout

```
the-hog-cli/
├── POSTHOG_SHA                    # pinned PostHog commit
├── scripts/sync-posthog.sh        # clones/checks out the pin
├── posthog/                       # gitignored; dev + CI only
├── build/extract.ts               # posthog → src/registry.json
├── src/
│   ├── index.ts                   # CLI entrypoint
│   ├── registry.json              # shipped: 262 tools in a palatable format
│   ├── commands.ts                # builds commander tree from registry
│   └── lib/{api,config,history,auth}.ts
├── thehogcli.skill.md             # Claude Code skill
└── tests/                         # vitest — extractor + CLI + history
```

## Commands (planned)

```
thehogcli --help
thehogcli <module> --help
thehogcli <module> <action> --<flag> ... --description "why you ran this"

thehogcli --history                      # paginated list
thehogcli --history <id>                 # full entry
thehogcli --rerun <id>                   # re-execute as-is
thehogcli --fork <id>                    # edit params, save as new entry

thehogcli login                          # interactive PAT setup
```

## Dev

```bash
npm install
npm run sync:posthog       # populate ./posthog (gitignored)
npm run build:extract      # produce src/registry.json
npm run build              # extract + ts compile
npm test
```
