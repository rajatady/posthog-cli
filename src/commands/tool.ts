import { randomUUID } from 'node:crypto'
import { Command } from 'commander'
import kleur from 'kleur'

import { fetch } from 'undici'

import { executeRequest, redactHeaders, resolveRequest } from '../lib/api.js'
import { loadConfig } from '../lib/config.js'
import { History, resolveHistoryPath } from '../lib/history.js'
import type { RegistryTool } from '../lib/registry.js'
import { isDestructive, isUnextractable } from '../lib/registry.js'
import { VERSION } from '../lib/version.js'

export interface ToolCommandOptions {
    toolName: string
    tool: RegistryTool
}

// Flags reserved by the CLI framework itself. When a handwritten tool's schema
// happens to declare a property whose kebab form matches one of these, we skip
// registering the option (commander rejects duplicates) and rely on auto-fill
// from Config or an explicit override via --args.
const RESERVED_FLAGS = new Set(['why', 'w', 'dry-run', 'json', 'project-id', 'help', 'h', 'version', 'v'])

// For reserved flags that map cleanly to a Config value, auto-fill at
// args-composition time via the commander attribute that commander would have
// assigned. `projectId` reads from cfg.projectId.
const RESERVED_AUTOFILL: Record<string, string> = {
    'project-id': '__autofill_projectId__',
}

export function registerToolCommand(parent: Command, opts: ToolCommandOptions): Command {
    const { toolName, tool } = opts
    // Show a short summary in the parent module's --help (where every tool is listed)
    // but attach the full description to the command itself — when the user drills into
    // `thehogcli <module> <tool> --help`, commander prints the full text.
    const shortSummary = truncate(tool.description, 120) || tool.title
    const fullSummary = (isUnextractable(tool) ? '[v1 / handwritten — use --args <json>] ' : '') + (tool.description || tool.title)
    const cmd = parent.command(toolName).summary(shortSummary).description(fullSummary)

    // Common options on every tool.
    // Named `--why` rather than `--description` because PostHog resources commonly have a
    // body field named `description` (action-create, dashboard-create, cohort-create, ...)
    // and a collision there would be confusing; `--why` is unambiguous as "why did you run this?"
    cmd.option(
        '-w, --why <text>',
        'Required. Short reason for running this query; stored in .thehogcli/history.db.'
    )
    cmd.option('--dry-run', 'Print the resolved HTTP request without sending it.', false)
    cmd.option('--json', 'Print response as raw JSON.', false)
    cmd.option('--project-id <id>', 'Override POSTHOG_CLI_PROJECT_ID for this call.')

    const flagMap = new Map<string, string>() // camelAttr -> original param name

    if (tool.http) {
        for (const pp of tool.http.pathParams) {
            const flag = safeFlag(pp)
            cmd.option(`--${flag} <value>`, `Path parameter: ${pp} (required).`)
            flagMap.set(kebabToCamel(flag), pp)
        }
        for (const qp of tool.http.queryParams) {
            const flag = safeFlag(qp)
            cmd.option(`--${flag} <value>`, `Query parameter: ${qp}.`)
            flagMap.set(kebabToCamel(flag), qp)
        }
        for (const bp of tool.http.bodyParams) {
            const flag = safeFlag(bp)
            cmd.option(`--${flag} <value>`, `Body parameter: ${bp} (JSON or literal).`)
            flagMap.set(kebabToCamel(flag), bp)
        }
    } else {
        // Handwritten v1 tool. If we resolved its input schema at build time,
        // render a proper flag per top-level property; otherwise fall back to a
        // generic --args <json> escape hatch. Either way, the call goes through
        // PostHog's universal /mcp_tools/{tool}/ endpoint.
        const props = tool.inputs?.properties ?? {}
        const required = new Set(tool.inputs?.required ?? [])
        const propNames = Object.keys(props)
        for (const name of propNames) {
            const meta = props[name]!
            const flag = safeFlag(name)
            if (RESERVED_FLAGS.has(flag)) {
                // Collisions with top-level CLI flags (--project-id, --json, --dry-run,
                // --why). Skip registration; the composer auto-fills from cfg where it
                // can (e.g. projectId gets cfg.projectId) and the user can still
                // override via --args.
                flagMap.set(RESERVED_AUTOFILL[flag] ?? '__skipped__', name)
                continue
            }
            const req = required.has(name) ? ' (required)' : ''
            const typeHint = typeLabel(meta)
            const descBase = meta.description ?? typeHint
            cmd.option(`--${flag} <value>`, `${descBase}${req}`)
            flagMap.set(kebabToCamel(flag), name)
        }
        cmd.option(
            '--args <json>',
            propNames.length > 0
                ? 'Optional JSON object; overrides/extends the per-field flags above.'
                : 'JSON object of arguments. Example: --args \'{"query":"SELECT 1"}\''
        )
    }

    cmd.action(async (rawOpts: Record<string, unknown>) => {
        await runTool(toolName, tool, rawOpts, flagMap)
    })

    return cmd
}

async function runTool(
    toolName: string,
    tool: RegistryTool,
    rawOpts: Record<string, unknown>,
    flagMap: Map<string, string>
): Promise<void> {
    const why = rawOpts.why as string | undefined
    if (!why) {
        console.error(
            kleur.red(
                `--why is required. One short sentence on why you're running this (stored in history).`
            )
        )
        process.exitCode = 1
        return
    }

    if (isDestructive(tool) && !rawOpts.dryRun) {
        console.error(
            kleur.yellow(`⚠  ${toolName} is destructive. Proceeding — re-run with --dry-run to preview.`)
        )
    }

    const cfg = loadConfig()
    if (rawOpts.projectId) cfg.projectId = rawOpts.projectId as string

    const params: Record<string, unknown> = {}
    for (const [camelAttr, original] of flagMap) {
        if (camelAttr === '__autofill_projectId__') {
            if (cfg.projectId) params[original] = cfg.projectId
            continue
        }
        if (camelAttr === '__skipped__') continue
        if (rawOpts[camelAttr] !== undefined) {
            params[original] = parseValue(rawOpts[camelAttr] as string)
        }
    }
    // For handwritten tools with a resolved schema, flag values are the args
    // themselves. Merge --args on top so explicit JSON always wins.
    if (isUnextractable(tool) && rawOpts.args !== undefined) {
        Object.assign(params, parseArgs(rawOpts.args as string))
    }

    const started = Date.now()
    let status = -1
    let responsePreview: string | null = null
    let exitCode = 0

    try {
        const outcome = isUnextractable(tool)
            ? await runHandwritten(toolName, cfg, rawOpts, params)
            : await runStandard(tool, cfg, params, rawOpts)
        status = outcome.status
        responsePreview = outcome.responsePreview
        exitCode = outcome.exitCode
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(kleur.red(msg))
        exitCode = 1
        responsePreview = `error: ${msg}`
    }

    const id = randomUUID()
    try {
        const history = new History(resolveHistoryPath())
        history.insert({
            id,
            createdAt: started,
            module: tool.module,
            tool: toolName,
            description: why,
            params,
            method: tool.http?.method ?? (isUnextractable(tool) ? 'POST' : null),
            path:
                tool.http?.path ??
                (isUnextractable(tool)
                    ? `/api/environments/{project_id}/mcp_tools/${toSnake(toolName)}/`
                    : null),
            responsePreview,
            exitCode,
            durationMs: Date.now() - started,
            forkedFrom: (rawOpts.forkedFrom as string | undefined) ?? null,
        })
        const short = id.slice(0, 8)
        console.error(kleur.dim(`→ history id ${short}  (${exitCode === 0 ? 'ok' : `exit ${exitCode}`})`))
    } catch (err) {
        console.error(kleur.yellow(`(history write failed: ${(err as Error).message})`))
    }

    process.exitCode = exitCode
}

interface ToolOutcome {
    status: number
    responsePreview: string | null
    exitCode: number
}

async function runStandard(
    tool: RegistryTool,
    cfg: ReturnType<typeof loadConfig>,
    params: Record<string, unknown>,
    rawOpts: Record<string, unknown>
): Promise<ToolOutcome> {
    const req = resolveRequest(cfg, tool.http!, params)

    if (rawOpts.dryRun) {
        console.log(kleur.cyan('DRY RUN — not sending:'))
        const pretty = req.url.replace(/%40current/g, kleur.dim('@current'))
        console.log(`${req.method} ${pretty}`)
        console.log('headers:', redactHeaders(req.headers))
        if (req.body != null) console.log('body:', JSON.stringify(req.body, null, 2))
        return { status: 0, responsePreview: '[dry-run]', exitCode: 0 }
    }

    const result = await executeRequest(req, cfg)
    if (rawOpts.json) console.log(JSON.stringify(result.body, null, 2))
    else printResult(result.status, result.body)
    return {
        status: result.status,
        responsePreview: previewOf(result.body),
        exitCode: result.status >= 400 ? 1 : 0,
    }
}

/**
 * Invoke a handwritten v1 tool via PostHog's universal MCP-tool endpoint:
 *   POST /api/environments/{project_id}/mcp_tools/{tool_name_snake}/
 *   Body: { "args": { ... } }
 * The backend (posthog/products/posthog_ai/backend/api/mcp_tools.py) resolves
 * the tool name in mcp_tool_registry and runs it with the user's credentials.
 */
async function runHandwritten(
    toolName: string,
    cfg: ReturnType<typeof loadConfig>,
    rawOpts: Record<string, unknown>,
    args: Record<string, unknown>
): Promise<ToolOutcome> {
    if (!cfg.apiKey) {
        throw new Error('Missing API key. Run `thehogcli login`.')
    }
    const project = cfg.projectId ?? '@current'
    const url = `${cfg.host.replace(/\/$/, '')}/api/environments/${encodeURIComponent(project)}/mcp_tools/${toSnake(toolName)}/`
    const headers = {
        Authorization: `Bearer ${cfg.apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': `thehogcli/${VERSION}`,
    }
    const body = JSON.stringify({ args })

    if (rawOpts.dryRun) {
        console.log(kleur.cyan('DRY RUN — not sending:'))
        const pretty = url.replace(/%40current/g, kleur.dim('@current'))
        console.log(`POST ${pretty}`)
        console.log('headers:', redactHeaders(headers))
        console.log('body:', body)
        return { status: 0, responsePreview: '[dry-run]', exitCode: 0 }
    }

    const res = await fetch(url, { method: 'POST', headers, body })
    const text = await res.text()
    let parsed: unknown = text
    if (text) {
        try {
            parsed = JSON.parse(text)
        } catch {
            parsed = text
        }
    }
    if (rawOpts.json) console.log(JSON.stringify(parsed, null, 2))
    else printHandwrittenResult(res.status, parsed)
    return {
        status: res.status,
        responsePreview: previewOf(parsed),
        exitCode: res.status >= 400 ? 1 : 0,
    }
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
    if (!raw || raw.trim() === '') return {}
    try {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>
        }
        throw new Error('--args must be a JSON object')
    } catch (err) {
        throw new Error(`failed to parse --args as JSON: ${(err as Error).message}`)
    }
}

function toSnake(kebab: string): string {
    return kebab.replace(/-/g, '_')
}

function typeLabel(meta: { type?: string | string[]; enum?: unknown[] }): string {
    if (meta.enum && meta.enum.length > 0) return `one of: ${meta.enum.join(', ')}`
    const t = Array.isArray(meta.type) ? meta.type.join('|') : meta.type
    return t ? `(${t})` : '(any)'
}

function printHandwrittenResult(status: number, body: unknown): void {
    const badge = status < 400 ? kleur.green(`${status}`) : kleur.red(`${status}`)
    console.error(`[${badge}]`)
    // mcp_tools endpoint wraps the real payload under { success, content }
    if (body && typeof body === 'object' && 'content' in body && typeof (body as { content: unknown }).content === 'string') {
        console.log((body as { content: string }).content)
    } else {
        console.log(typeof body === 'string' ? body : JSON.stringify(body, null, 2))
    }
}

/**
 * Convert a param key into a stable kebab-case flag.
 *   insightId          → insight-id     (camelCase split)
 *   group_type_index   → group-type-index
 *   id__in             → id-in          (collapse repeated separators — else commander's
 *                                        internal camelcase helper chokes on empty segments)
 * Round-trip via kebabToCamel(name) recovers the original camelCase input
 * (because we re-camelize on every `-`), so the param lookup map still works.
 */
function safeFlag(name: string): string {
    return name
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/[_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase()
}

function kebabToCamel(kebab: string): string {
    return kebab.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

function parseValue(raw: string): unknown {
    if (raw === 'true') return true
    if (raw === 'false') return false
    if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10)
    if (/^-?\d+\.\d+$/.test(raw)) return Number.parseFloat(raw)
    if (raw.startsWith('{') || raw.startsWith('[')) {
        try {
            return JSON.parse(raw)
        } catch {
            return raw
        }
    }
    return raw
}

function truncate(s: string, n: number): string {
    if (s.length <= n) return s
    return `${s.slice(0, n - 1).trimEnd()}…`
}

function printResult(status: number, body: unknown): void {
    const badge = status < 400 ? kleur.green(`${status}`) : kleur.red(`${status}`)
    console.error(`[${badge}]`)
    if (typeof body === 'string') {
        console.log(body)
    } else {
        console.log(JSON.stringify(body, null, 2))
    }
}

function previewOf(body: unknown): string {
    if (body == null) return ''
    const s = typeof body === 'string' ? body : JSON.stringify(body)
    return s.slice(0, 500)
}
