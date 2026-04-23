# AGENTS.md

Operational guide for coding agents (and engineers new to the repo) working on **thehogcli**. Written to the spec at [agents.md](https://agents.md/): present-tense, load-bearing context that is not derivable from reading the source.

This file is the single onboarding document. Read it top-to-bottom before making changes. It assumes zero prior context about thehogcli, PostHog, or the PostHog MCP.

---

## 1. What this project is

**thehogcli** is a command-line interface that mirrors the [PostHog MCP](https://github.com/PostHog/posthog/tree/master/services/mcp) tool surface — 262 tools across 38 product modules — without the ~250,000-token schema overhead that coding agents pay to connect an MCP client. The CLI hits the same PostHog REST endpoints the MCP wraps, but exposes each tool as a plain subcommand an agent (or human) invokes on demand.

The core claim:

> An MCP connection preloads every tool schema into the agent's context at startup. Replacing the MCP with a CLI reduces that to the ~1 kB it costs to teach an agent the invocation pattern.

Every executed call is captured locally in a SQLite history (`.thehogcli/history.db`) with a required `--why` annotation, so context loss does not erase the work.

The package is published as `thehogcli` on npm. ~76 kB gzipped, 18 files, zero runtime dependency on the PostHog monorepo.

---

## 2. Fast path: getting a working checkout

```bash
git clone git@github.com:rajatady/posthog-cli.git
cd posthog-cli
npm install
npm run sync:posthog          # clones PostHog monorepo at the pinned SHA (~500 MB, blobless)
npm run build:extract         # regenerates src/registry.json from the pin
npm test                      # 35 vitest cases; expect green
npm run dev -- --help         # exercise the CLI via tsx (no compile step)
```

End-user install (what someone using the published npm package does):
```bash
npm install -g thehogcli
thehogcli login
thehogcli feature-flags feature-flag-get-all --why "check" --limit 5
```

---

## 3. Three mental models that must be internalized

### 3.1 The CLI is a distillation of PostHog's own codegen

The PostHog MCP is not hand-written. It is codegenerated from the Django REST Framework OpenAPI schema plus per-product YAML configs (`products/*/mcp/tools.yaml`). The pipeline upstream is:

```
Django serializer → frontend/tmp/openapi.json → Orval Zod schemas
                 → tools.yaml selects operationIds
                 → posthog/services/mcp/scripts/generate-tools.ts
                 → posthog/services/mcp/src/tools/generated/<product>.ts
```

**thehogcli's extractor (`build/extract.ts`) consumes the already-committed generated files in that repo** — specifically the TS handler bodies in `services/mcp/src/tools/generated/`, plus the metadata in `services/mcp/schema/tool-definitions-all.json` and the input schemas for 17 handwritten v1 tools in `services/mcp/schema/tool-inputs.json`. It distills these into one compact artifact: `src/registry.json` (~340 kB, 262 tools).

Implication: the CLI never hand-maintains a tool list. When PostHog ships a new tool upstream, bumping `POSTHOG_SHA` and re-running the extractor picks it up.

### 3.2 Two-sided build

```
┌──────────────────────────────────────┐    ┌─────────────────────────────────┐
│   DEV / CI (maintainer-only)         │    │   RUNTIME (what npm ships)      │
│   ────────────────────────────       │    │   ───────────────────────────   │
│   posthog/ (gitignored clone)        │    │   dist/ (compiled JS)           │
│   build/extract.ts                   │──▶ │   dist/registry.json            │
│   scripts/sync-posthog.sh            │    │   package.json                  │
│   POSTHOG_SHA (the pin)              │    │                                 │
└──────────────────────────────────────┘    └─────────────────────────────────┘
```

The `posthog/` directory, `build/`, and `scripts/` never ship to npm. `package.json.files` is locked to `["dist/", "README.md", "LICENSE"]`. The extractor runs exactly once per PostHog pin bump, not at install time, not at runtime.

### 3.3 `@current` first

Most PostHog endpoint paths contain `{project_id}`. PostHog's Django routing (`posthog/api/routing.py`, `posthog/api/team.py`) accepts the literal string `@current` in that slot and server-side expands it to the authenticated user's active team. The CLI exploits this: when no `projectId` is pinned in config, `{project_id}` is substituted with `@current` at request time. Result: a user who just ran `thehogcli login` can execute tools without ever being asked "which project?". An explicit `--project-id`, env var, or `thehogcli use <id>` override wins when the user wants to pin a specific target.

The same pattern applies to `{organization_id}`.

---

## 4. Architecture

```
posthog-cli/
├── AGENTS.md                 # this file
├── README.md                 # end-user documentation
├── LICENSE                   # MIT
├── POSTHOG_SHA               # pinned upstream commit (40-char SHA)
├── package.json              # name: thehogcli, bin: thehogcli → dist/index.js
├── tsconfig.json             # dev + typecheck (has sourceMap)
├── tsconfig.build.json       # release build (no sourceMap, extends above)
├── vitest.config.ts          # includes tests/ and src/; v8 coverage
├── .gitignore                # posthog/, dist/, .thehogcli/, *.tgz, IDE
│
├── scripts/
│   └── sync-posthog.sh       # blobless clone + checkout of POSTHOG_SHA
│
├── build/                    # dev-only; never shipped to npm
│   └── extract.ts            # posthog/services/mcp/* → src/registry.json
│
├── src/
│   ├── index.ts              # CLI entry; configureNet → loadRegistry → commander tree
│   ├── registry.json         # the 262-tool catalog (shipped)
│   │
│   ├── commands/
│   │   ├── tool.ts           # generic executor for every tool in the registry
│   │   ├── login.ts          # login, whoami, projects, use, scopes
│   │   └── history.ts        # history list/show (rerun + fork stubbed)
│   │
│   └── lib/
│       ├── api.ts            # fetch wrapper; resolves {project_id}; auto-refresh on 401
│       ├── oauth.ts          # DCR (RFC 7591) + authorization code + PKCE (RFC 7636) + refresh
│       ├── discover.ts       # auto-pick project/org (mirrors PostHog MCP StateManager)
│       ├── scopes.ts         # union of every tool.scopes in registry → requested scopes
│       ├── config.ts         # env vars + ~/.thehogcli/config.json (mode 0600)
│       ├── history.ts        # SQLite (better-sqlite3); .thehogcli/history.db
│       ├── net.ts            # undici global dispatcher; IPv4 default
│       ├── auth.ts           # stdin prompt helpers (ask, askSecret)
│       ├── registry.ts       # types + loadRegistry() + classification helpers
│       └── version.ts        # single source of truth for VERSION string
│
└── tests/                    # vitest
    ├── extractor.test.ts     # regex extractor against a fixture
    ├── cli-registration.test.ts
    ├── history.test.ts
    ├── scopes.test.ts
    ├── version.test.ts
    └── fixtures/mcp/feature_flags.sample.ts
```

---

## 5. The data pipeline end-to-end

1. **`scripts/sync-posthog.sh`** (run: `npm run sync:posthog`) shallow-clones `github.com/PostHog/posthog` with `--filter=blob:none` into `./posthog/` and checks out the SHA in `POSTHOG_SHA`. Blobless clone keeps the checkout ~500 MB rather than multi-GB.

2. **`build/extract.ts`** (run: `npm run build:extract`) walks:
   - `posthog/services/mcp/schema/tool-definitions-all.json` → all 262 tool metadata (category, description, scopes, annotations)
   - `posthog/services/mcp/src/tools/generated/*.ts` → the 231 codegen'd handlers, from which regex extracts HTTP method + path template + path/query/body param names
   - `posthog/services/mcp/src/tools/**/*.ts` (non-generated) → finds handwritten tool files, pairs `name: '<kebab>'` literals with `import { ...Schema } from '@/schema/tool-inputs'`, resolves 17 of the 31 handwritten tools' input schemas

   Produces: `src/registry.json`.

3. **`tsc -p tsconfig.build.json`** (run: `npm run build:ts`) compiles `src/` to `dist/`, copies `src/registry.json` to `dist/registry.json` via `resolveJsonModule`.

4. **`npm publish`** ships `dist/` + `README.md` + `LICENSE` + `package.json`. Total tarball ~76 kB gzipped.

5. At runtime on the end user's machine:
   - `dist/index.js` loads `dist/registry.json`
   - Builds commander tree from registry
   - Dispatches REST calls to `https://us.posthog.com` (or whatever `--host`)

---

## 6. Non-obvious conventions an agent must know

Non-exhaustive. These are the rules that are not visible from reading one file.

### 6.1 `--why`, not `--description`

The CLI-level annotation flag is named `--why`, not `--description`. This is deliberate: PostHog resources commonly have a body field literally named `description` (e.g., `action-create`, `dashboard-create`, `cohort-create`, `survey-create`, `experiment-create`, `insight-create`). Naming the CLI-level flag `--description` would collide with those tool-level body params and commander would throw at registration time. `--why` is also semantically better: the annotation is "why did you run this", not "describe the thing being created".

### 6.2 Reserved CLI flag set

A handwritten tool whose input schema declares a property named `projectId` (e.g., `get-llm-total-costs-for-project`) would kebab-ify to `--project-id` and collide with the CLI's own reserved `--project-id`. The resolution:

- `RESERVED_FLAGS` in `src/commands/tool.ts` lists the reserved kebab names
- When a schema property's kebab form is reserved, the CLI **does not register a second flag**
- For specific reserved flags that map cleanly to config values (currently just `project-id` → `cfg.projectId`), the args composer auto-fills from config at call time
- The user can still override via `--args '<json>'`

If adding a new reserved CLI flag, update `RESERVED_FLAGS` and consider whether it deserves an autofill entry in `RESERVED_AUTOFILL`.

### 6.3 Kebab ↔ snake ↔ camel round-trip

Tool input properties come in three shapes:
- Camel: `insightId` (handwritten schemas)
- Snake: `project_id`, `group_type_index` (codegen'd HTTP params)
- Django-style: `id__in` (repeated separators — would trip commander's internal camelcase helper if emitted as `--id--in`)

`safeFlag()` in `src/commands/tool.ts` normalizes all three to a clean kebab form (`insight-id`, `project-id`, `group-type-index`, `id-in`) by splitting camelCase boundaries and collapsing repeated separators. `kebabToCamel()` is its inverse. The pairing is used to build a `flagMap: Map<camelAttr, originalPropName>` so commander's attribute (camelCase) can be looked up back to the original key when composing the outgoing request body/query.

When adding a new input property shape, verify the round-trip by running `thehogcli <module> <tool> --help` and `thehogcli <module> <tool> --<flag> value --dry-run` to confirm flags are accepted and the value lands in the request under the original key name.

### 6.4 IPv4-only undici dispatcher

`src/lib/net.ts` sets a process-wide undici `Agent` with `connect: { family: 4 }`. This is a deliberate workaround for a Node foot-gun: hosts that resolve to both IPv4 and IPv6 addresses trigger Node's "happy-eyeballs" logic (`autoSelectFamily`, default in Node 20+). On networks where the IPv6 path is broken (no IPv6 route, common on consumer Wi-Fi + VPNs), IPv6 connections fail instantly with `EHOSTUNREACH`. Before the slower IPv4 connections complete, the aggregate error bails the whole `fetch` with a cryptic `fetch failed`.

Forcing `family: 4` skips IPv6 entirely with no measurable cost for HTTPS against PostHog. Override via `THEHOGCLI_NET_FAMILY=0` (dual-stack) or `=6` (IPv6-only, e.g., IPv6-only CI).

Do **not** remove this without a specific reason.

### 6.5 `@current` alias

`src/lib/api.ts:resolveRequest` substitutes `@current` for `{project_id}` when no project is pinned. This works because PostHog's server expands the alias. Before writing new code that requires a numeric project id at request time, check whether the endpoint accepts `@current` — most do.

### 6.6 Empty env vars are absent

`POSTHOG_CLI_PROJECT_ID=` (empty string) on the command line is **not** the same as unset in bash; `process.env.POSTHOG_CLI_PROJECT_ID` is `""`. The `envOr()` helper in `src/lib/config.ts` treats empty strings as absent. New config fields should use `envOr()` for the same reason.

### 6.7 Reactive token refresh

`src/lib/api.ts:executeRequest` refreshes the OAuth access token only on 401 response. It does **not** proactively refresh before `expires_at`. This is intentional:

- PATs never expire and have no refresh token, so a proactive-refresh path would need a branch
- OAuth access tokens last long enough (1 hour default) that one 401 + retry is rare
- `saveConfig` is called on refresh, which means a proactive refresher running concurrently with another `thehogcli` process could race on the config file

If adding proactive refresh, handle both the PAT-no-refresh-token case and file-lock the config write.

### 6.8 ESM `.js` extensions

All relative imports in `src/` end with `.js` (not `.ts`, not extensionless). Node's ESM loader requires explicit extensions; `tsx` dev mode tolerates the TS extension, but compiled `dist/*.js` must use `.js`. When adding a new file in `src/`, imports from it must follow the same rule. Violation surfaces as `ERR_MODULE_NOT_FOUND` only on `npm install`'d users, not in local dev.

### 6.9 Handwritten v1 tools go through the universal endpoint

31 of the 262 tools have no HTTP spec that the extractor can derive (the handlers are hand-written, not template-generated). All of them are reachable through PostHog's universal invocation endpoint:

```
POST /api/environments/{project_id}/mcp_tools/{tool_name_snake}/
Body: { "args": { ... } }
```

The backend (`posthog/products/posthog_ai/backend/api/mcp_tools.py`) looks up `tool_name_snake` in the MCP tool registry and runs it with the user's auth. The CLI uses a single adapter (`runHandwritten` in `src/commands/tool.ts`) for all 31 tools — no per-tool code. Tool name mapping is kebab → snake (`execute-sql` → `execute_sql`).

17 of the 31 tools have per-field flags because their input schemas are present in `tool-inputs.json` and resolved by the extractor. 14 do not (most use `createQueryWrapper(...)` factory with inline Zod schemas that the extractor does not parse). Those 14 take `--args '<json>'` only.

---

## 7. Design decisions currently in place

Each entry states the decision, the constraint that drove it, and alternatives considered. An agent proposing a change should engage with the rejected alternatives, not reinvent them.

### 7.1 Language: TypeScript on Node

- **In place**: Node ≥20, pure TypeScript, ESM output.
- **Why**: The upstream PostHog MCP is TypeScript; reusing their extractor vocabulary (Zod, Orval, codegen'd handlers) is direct. The npm ecosystem is the natural distribution channel for a tool coding agents use.
- **Rejected**: Rust (matches PostHog's official `posthog-cli`, but that CLI is narrow — `login`, `query`, `sourcemap` only; rewriting the MCP's Zod layer in Rust is a large undertaking). Python (lightweight install via pip, but rebuilds the OpenAPI→schema plumbing from scratch). Go (single binary, but most boilerplate).

### 7.2 Extractor: regex, not TS AST

- **In place**: `build/extract.ts` parses the PostHog-generated handler files with regex, not a TypeScript AST.
- **Why**: The generator produces highly regular output (`name:` literal, `method:` string, `path:` template literal, `query:` / `body:` object at predictable positions). Regex is ~20× less code, faster to debug, and the fixture test in `tests/extractor.test.ts` catches format drift loudly.
- **Rejected**: TypeScript compiler API. Correct but heavy; worth switching to if the PostHog generator ever stops being regular.
- **Implication**: A PostHog change that modifies the handler template will fail `tests/extractor.test.ts`. Update the fixture `tests/fixtures/mcp/feature_flags.sample.ts` and the regexes together.

### 7.3 Shipped artifact: distilled JSON, not codegen at install time

- **In place**: `src/registry.json` is checked into source and ships in the npm tarball. The published package does not run any codegen at install time.
- **Why**: Agents and users want `npm install -g thehogcli && thehogcli login && <tool>` to work immediately with zero network, zero clone, zero build. The PostHog monorepo is ~500 MB even with `--filter=blob:none`; installing that at user time is unacceptable.
- **Rejected**: Code generation at install time (Orval-style). Runtime-dynamic reading of a remote OpenAPI JSON (slow first run; agents hate latency on `--help`).

### 7.4 History: SQLite, not JSONL

- **In place**: `.thehogcli/history.db` via `better-sqlite3`.
- **Why**: Indexed pagination, filter by module/tool, prefix-match on id, atomic writes, WAL journal. A user running 50 invocations/day across a month still gets subsecond `thehogcli history --module feature-flags --tool feature-flag-get-all`.
- **Rejected**: JSONL (simple but unindexed; fine for 100 entries, painful at 10,000). JSONL + SQLite index (two moving parts; no durability benefit over SQLite alone).

### 7.5 Auth: OAuth 2.0 code + PKCE + DCR, not the CLI device flow

- **In place**: `src/lib/oauth.ts` implements [RFC 7591](https://www.rfc-editor.org/rfc/rfc7591.html) Dynamic Client Registration + [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636.html) PKCE authorization code flow. On first login per host, the CLI POSTs to `/oauth/register` to mint its own public `client_id`. Subsequent logins reuse the cached `client_id`. Browser is redirected to `/oauth/authorize`, authorization code lands on a local loopback callback, exchanged at `/oauth/token` with the PKCE verifier.
- **Why**: The CLI needs all 72 scopes the registry tools declare. PostHog's existing "CLI device flow" (`/api/cli-auth/device-code/` + `/poll/`) hardcodes a `USE_CASE_SCOPES` map in `cliAuthorizeLogic.ts` that only exposes 3 use-cases (`schema`, `error_tracking`, `endpoints`) totaling ~6 scopes. That is fine for PostHog's own error-tracking CLI; it is fundamentally inadequate for a full MCP-surface CLI.
- **Rejected**: The CLI device flow (scope-capped). Pre-registered OAuth `client_id` (requires publishing a secret or dealing with out-of-band registration). PAT copy-paste (kept as `--manual` escape hatch only — users should not be pasting API keys into terminals when PKCE + browser is available).

### 7.6 Scopes derived from registry, not maintained

- **In place**: `src/lib/scopes.ts:deriveAllScopes(registry)` returns `Set<string>` = union of every `tool.scopes`. Called by the `login` flow to build the OAuth authorize URL's `scope=` parameter.
- **Why**: Zero hand maintenance. When PostHog adds a new tool, `scopes` grows automatically on the next `build:extract`. `tests/scopes.test.ts` pins canonical shapes (`feature_flag:read`, `dashboard:read`, …) and format (`<object>:(read|write)`) so a registry regression that drops a scope surfaces immediately.
- **Rejected**: Hand-maintained scope list (bit-rots). Hardcoded union from PostHog's `CLI_SCOPES` (too narrow).

### 7.7 Project auto-discovery

- **In place**: After login, `src/lib/discover.ts:autoDiscover()` calls `GET /api/personal_api_keys/@current` for `scoped_teams` and `GET /api/users/@me/` for the active team. Decision tree mirrors `posthog/services/mcp/src/lib/StateManager.ts:_getDefaultOrganizationAndProject`. At request time, `@current` handles the common case without any pinned project.
- **Why**: Agents must not be prompted for a numeric project id they do not know. The MCP resolves this server-side; the CLI should match.
- **Rejected**: Interactive "pick a project" prompt (annoying; breaks non-interactive usage). Mandatory env var (forces every user to dig through the PostHog URL bar).

### 7.8 Handwritten v1 tools: single universal adapter

- **In place**: `src/commands/tool.ts:runHandwritten` POSTs to `/api/environments/{project_id}/mcp_tools/{tool_snake}/` with `{ "args": { ... } }` for all 31 v1 tools.
- **Why**: Writing 31 per-tool adapters duplicates work PostHog already did server-side. The universal endpoint is stable (exposed for exactly this purpose; see `posthog/products/posthog_ai/backend/api/mcp_tools.py`).
- **Rejected**: Per-tool adapters (boilerplate; 31× the code). Parsing inline Zod from the 14 remaining schemaless handwritten tools with a custom TS AST pass (possible future work; low ROI vs `--args '<json>'`).

### 7.9 Git submodule: SHA pin + sync script, not real submodule

- **In place**: `POSTHOG_SHA` holds a commit hash. `scripts/sync-posthog.sh` clones into `./posthog/` (gitignored) and checks out that SHA.
- **Why**: A real git submodule makes every `git clone` download PostHog, punishes first-time contributors. The SHA pin file is human-readable, diffable, and explicitly versioned in commits.
- **Rejected**: Real git submodule (clone-time cost). Sparse submodule with just `services/mcp/` (reduces size but adds configuration complexity without clear benefit for a pipeline that runs only on pin bumps).

### 7.10 Package layout

- **In place**: `files: ["dist/", "README.md", "LICENSE"]`. Tarball is 76 kB gzipped with 18 files. `tsconfig.build.json` disables source maps (saves ~70 kB).
- **Why**: End users get the minimum needed to run. Nothing in `build/`, `scripts/`, `tests/`, `posthog/` reaches the published package.
- **Rejected**: Shipping source (`src/**`) alongside `dist/` (doubles the tarball for marginal developer benefit; source is on GitHub). Shipping `build/extract.ts` so users can re-generate locally (would pull in the extractor's posthog-shaped dependencies).

---

## 8. Adding a new command or tool

### 8.1 To expose a new PostHog endpoint

Usually nothing to do beyond a PostHog pin bump:
1. PostHog merges the new endpoint and its `tools.yaml` entry upstream.
2. Bump `POSTHOG_SHA` to the new commit.
3. `npm run sync:posthog && npm run build:extract`.
4. `npm test` to verify 35/35 green and the registry registered without collisions.
5. `thehogcli <module> <tool> --help` to eyeball the generated flags.

If the new tool is handwritten (v1) and its input schema is in `tool-inputs.json`, it will also get per-field flags automatically. If the schema is defined inline in its TS file, it will fall back to `--args '<json>'`.

### 8.2 To add a CLI-level subcommand (not a PostHog tool)

For commands like `login`, `whoami`, `history`, `projects`, `use`, `scopes`: add to `src/commands/<name>.ts` following the existing module pattern (exports `register<Name>Command(program: Command)`), then wire it in `src/index.ts:main`. Keep reserved flags (`--why`, `--dry-run`, `--json`, `--project-id`) out of new top-level command flag names to avoid collision with the tool executor.

### 8.3 Flag naming rules

- Every tool execution requires `--why <text>` (captured in history).
- Param flags are kebab-case; `safeFlag()` handles the snake/camel/Django `__` → kebab conversion.
- Use `-w` as the only short form. Do not add `-d`, `-p`, or other single-letter aliases — they risk collision with per-tool flags.

---

## 9. Bumping the PostHog pin

```bash
# Find the new SHA (e.g., latest on PostHog main):
git -C posthog fetch origin main
git -C posthog rev-parse origin/main > /tmp/newsha

# Update the pin:
cat /tmp/newsha > POSTHOG_SHA

# Re-sync and re-extract:
npm run sync:posthog
npm run build:extract
npm test

# If tests pass and the registry diff looks sane:
git add POSTHOG_SHA src/registry.json
git commit -m "chore: bump POSTHOG_SHA to <short-sha>"
```

Expected registry diff signals:
- New tool entries → PostHog added tools
- Changed `http.path` → an endpoint moved (verify not a breaking change)
- Removed tools → the CLI loses those subcommands on next release; check the release note

If `tests/extractor.test.ts` fails after a sync, PostHog changed the generator template. Update the extractor and the fixture together.

---

## 10. Releasing a new version

```bash
# 1. Bump version in three places (kept in sync by tests/version.test.ts):
#    - package.json                "version": "1.x.y"
#    - src/lib/version.ts          export const VERSION = '1.x.y'
#    (CHANGELOG.md if it exists)

# 2. Run the full suite locally:
rm -rf dist *.tgz
npm run build
npm test
npm pack --dry-run    # confirm tarball shape

# 3. Publish:
npm publish           # prepublishOnly re-runs build + test

# 4. Tag and push:
git tag v1.x.y
git push origin main --tags
gh release create v1.x.y --generate-notes
```

`prepublishOnly` is the guardrail — if tests fail or the build breaks, publish aborts.

---

## 11. Testing

35 vitest cases currently. Overall line coverage ~22%. The coverage is uneven by design:

| Area                        | Line coverage | Validated by |
|-----------------------------|--------------|--------------|
| `src/lib/scopes.ts`         | 100%         | `tests/scopes.test.ts` |
| `src/lib/version.ts`        | 100%         | `tests/version.test.ts` |
| `src/lib/history.ts`        | 92%          | `tests/history.test.ts` |
| `src/lib/registry.ts`       | 76%          | `tests/cli-registration.test.ts` |
| `build/extract.ts`          | 41%          | `tests/extractor.test.ts` (fixture-based) |
| `src/commands/tool.ts`      | 29%          | `tests/cli-registration.test.ts` (registration only, not runtime) |
| `src/lib/oauth.ts`          | <1%          | manual only |
| `src/lib/api.ts`            | 4%           | manual only |
| `src/lib/discover.ts`       | 0%           | manual only |
| `src/commands/login.ts`     | 0%           | manual only |

The untested modules are the network/credentials/state-machine paths. Before landing a behavior change to any of them, either add a unit test with mocked `fetch` or verify end-to-end against a real PostHog project and log the manual test in the PR description.

**`tests/cli-registration.test.ts` is the load-bearing regression guard.** It iterates every tool in the registry and asserts `registerToolCommand` does not throw. This catches classes of bugs the extractor cannot see — e.g., a new PostHog handwritten tool that declares a `projectId` property would collide with the CLI's reserved `--project-id` and fail at commander registration. The test surfaces this at commit time, not at user runtime.

Running coverage:
```bash
npm install --no-save @vitest/coverage-v8
npx vitest run --coverage
```

---

## 12. What is deliberately not implemented

Not out of laziness — these were considered and declined for specific reasons. Do not add them without a concrete user need.

- **`thehogcli history rerun <id>`** and **`thehogcli history fork <id>`**: stubs. Wiring them requires serializing a history entry's params back into the commander invocation and re-driving the tool executor. Roughly 60 lines. Skipped at v1 because the `--dry-run` output + history is enough to reconstruct a call by hand.
- **Per-tool adapters for the 14 schemaless handwritten tools** (`query-trends`, `query-funnel`, `query-retention`, `query-stickiness`, `query-paths`, `query-lifecycle`, `query-trends-actors`, `query-llm-traces-list`, `query-llm-trace`, `query-error-tracking-issues`, `query-session-recordings-list`, `external-data-sources-db-schema`, `external-data-sources-jobs`, `property-definitions`): `--args '<json>'` is the escape hatch. Adding per-field flags needs a TS AST pass over the handwritten TS files to parse inline Zod. Low ROI at current usage.
- **Proactive token refresh**: reactive-on-401 works. See §6.7 for why.
- **Shell completion (bash/zsh/fish)**: 38 modules × 262 tools is enough surface that completion would be valuable. Add when a user asks and there is time to maintain it.
- **`--output <file>` flag**: users can pipe shell-side. Reinventing redirection inside the CLI buys nothing.
- **Rate-limit handling**: PostHog returns a standard 429 with `Retry-After`; current behavior prints the response and exits 1. Add retry-with-backoff when someone hits it.
- **Multi-organization projects listing**: `thehogcli projects` currently shows only the active organization's projects. Iterating all orgs the token has access to is a 10-line addition; do it when a multi-org user complains.

---

## 13. Known limitations and foot-guns

- **Destructive operations warn but do not gate.** Tools with `annotations.destructiveHint: true` print a yellow banner and proceed. `--dry-run` is the safety valve. A future `--yes` flag + interactive confirmation is the right fix but is not present.
- **Login with a different host overwrites `client_id`.** `saveConfig` replaces the single `client_id` field rather than maintaining a `{host → client_id}` map. A user alternating between US and EU will re-do DCR each time. Fix by making `client_id` a nested object keyed by host.
- **History writes are not cross-process atomic.** Two `thehogcli` processes running simultaneously in the same cwd both write to `.thehogcli/history.db` under SQLite's WAL mode. SQLite handles the write locking; the risk is only in application logic that reads-modifies-writes history rows, which currently does not happen.
- **OAuth callback server binds to `127.0.0.1:0`** (random port). If firewall rules block loopback callback, login hangs until the 5-minute deadline. No workaround beyond `--manual`.
- **`prepublishOnly` runs the full extractor path**, which requires `./posthog/` to exist. Before `npm publish`, ensure the workspace has been synced (`npm run sync:posthog`) even if it is not freshly cloned.

---

## 14. Troubleshooting

If you see this error, check that file first.

| Symptom                                                   | Likely file         |
|----------------------------------------------------------|---------------------|
| `fetch failed` with no HTTP status                       | `src/lib/net.ts` — IPv6/IPv4 happy-eyeballs; verify `family: 4`. `err.cause` (surfaced by `fetchWithCause` in `oauth.ts`) has the real reason. |
| `Cannot add option '--X' due to conflicting flag '--X'`  | `src/commands/tool.ts` — property collides with a reserved CLI flag or with another prop in the same tool. Extend `RESERVED_FLAGS`. |
| `ERR_MODULE_NOT_FOUND` after `npm install`               | `src/**/*.ts` has an extensionless relative import. All relative imports must end in `.js`. |
| `/api/projects//...` (double slash) in dry-run URL        | `src/lib/config.ts:envOr` — env var is empty string, not null. Fix: use `envOr`. |
| `Missing required path parameter: --X`                   | `src/lib/api.ts:resolveRequest` — a non-project path param is missing. User needs to pass `--X`. |
| `--version` prints wrong version                          | `src/lib/version.ts` and `package.json` are out of sync. `tests/version.test.ts` catches this. |
| `no history entry matching <id>`                         | `src/lib/history.ts:get` does a prefix match on the primary key. If the prefix is ≤8 chars and unique, it matches. |
| `Tool '<name>' not found` (HTTP 404 from PostHog)         | `src/commands/tool.ts:toSnake` — the kebab→snake conversion produced a name the server does not know. Compare with the MCP tool name. |

---

## 15. External references

- [`agents.md`](https://agents.md/) — the AGENTS.md convention this file follows.
- [PostHog monorepo](https://github.com/PostHog/posthog) — upstream source of truth.
- [`posthog/services/mcp/ARCHITECTURE.md`](https://github.com/PostHog/posthog/blob/master/services/mcp/ARCHITECTURE.md) — the MCP's own architecture doc. Describes the Cloudflare Workers + Durable Object deployment, the scope system, OAuth metadata endpoints.
- [`posthog/services/mcp/src/lib/StateManager.ts`](https://github.com/PostHog/posthog/blob/master/services/mcp/src/lib/StateManager.ts) — the project/org discovery logic mirrored in `src/lib/discover.ts`.
- [`posthog/posthog/api/oauth/dcr.py`](https://github.com/PostHog/posthog/blob/master/posthog/api/oauth/dcr.py) — the Dynamic Client Registration endpoint.
- [`posthog/posthog/scopes.py`](https://github.com/PostHog/posthog/blob/master/posthog/scopes.py) — the authoritative list of API scope objects.
- [`posthog/products/posthog_ai/backend/api/mcp_tools.py`](https://github.com/PostHog/posthog/blob/master/products/posthog_ai/backend/api/mcp_tools.py) — the universal MCP tool invocation endpoint used by handwritten v1 tools.
- RFC 7591 — OAuth Dynamic Client Registration.
- RFC 7636 — OAuth PKCE.
- RFC 8628 — OAuth Device Authorization (used by PostHog's own CLI, not by this CLI).

---

## 16. Final principles

When in doubt, follow these:

1. **Distill, don't duplicate.** The upstream PostHog MCP is the source of truth. This CLI is a shape-shifter over that surface.
2. **Ship the output, not the input.** The user never needs the PostHog monorepo.
3. **Test the extractor, trust the runtime.** Extractor regressions are silent; runtime regressions are loud. Invest test effort accordingly.
4. **`--dry-run` first.** Every destructive or ambiguous change should be previewable.
5. **Prefer server-side `@current`** over asking users for ids.
6. **Reactive beats proactive** for token refresh, for auto-selection of defaults, for error handling. Less state, fewer races.
7. **If a decision was considered and rejected**, that rejection is often load-bearing. Re-read §7 before arguing to reverse one.
