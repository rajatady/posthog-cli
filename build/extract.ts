#!/usr/bin/env tsx
/**
 * Distill posthog/services/mcp into src/registry.json — the artifact shipped in
 * the npm package. The CLI never reads posthog/ at runtime.
 *
 * Sources consumed:
 *   posthog/services/mcp/schema/tool-definitions-all.json
 *     -> per-tool metadata: category, description, title, scopes, annotations
 *   posthog/services/mcp/src/tools/generated/<product>.ts
 *     -> per-tool HTTP routing: method, path template, path/query/body params
 *
 * Output shape (src/registry.json):
 *   {
 *     posthogSha: string,
 *     generatedAt: string,
 *     modules: { [moduleSlug]: { title, tools: string[] } },
 *     tools: {
 *       [toolName]: {
 *         module, category, title, description, scopes, annotations,
 *         http: { method, path, pathParams, queryParams, bodyParams }
 *       }
 *     }
 *   }
 */
import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '..')
const POSTHOG = join(REPO, 'posthog')
const SCHEMA_DIR = join(POSTHOG, 'services/mcp/schema')
const GEN_TOOLS_DIR = join(POSTHOG, 'services/mcp/src/tools/generated')
const HANDWRITTEN_TOOLS_DIR = join(POSTHOG, 'services/mcp/src/tools')
const OUT = join(REPO, 'src/registry.json')
const SHA_FILE = join(REPO, 'POSTHOG_SHA')

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

interface HttpSpec {
    method: HttpMethod
    path: string
    pathParams: string[]
    queryParams: string[]
    bodyParams: string[]
}

interface ToolDefinitionAll {
    category?: string
    feature?: string
    title?: string
    summary?: string
    description?: string
    required_scopes?: string[]
    annotations?: Record<string, unknown>
    new_mcp?: boolean
}

/**
 * JSON Schema for a tool's top-level input object.
 * We only care about `properties`, `required`, and per-field description/type —
 * enough to render CLI flags. Nested objects flow through `--args` as raw JSON.
 */
interface InputsSchema {
    type?: string
    properties?: Record<string, PropertySchema>
    required?: string[]
}

interface PropertySchema {
    type?: string | string[]
    description?: string
    default?: unknown
    enum?: unknown[]
    anyOf?: PropertySchema[]
    oneOf?: PropertySchema[]
    // plus anything else JSON-Schema-ish we ignore
}

interface RegistryTool {
    module: string
    category: string
    title: string
    description: string
    scopes: string[]
    annotations: Record<string, unknown>
    http: HttpSpec | null
    /** Present only for handwritten v1 tools whose schema we could resolve. */
    inputs?: InputsSchema | null
}

interface Registry {
    posthogSha: string
    generatedAt: string
    modules: Record<string, { title: string; tools: string[] }>
    tools: Record<string, RegistryTool>
}

function moduleSlug(category: string): string {
    return category
        .toLowerCase()
        .replace(/&/g, 'and')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
}

function die(msg: string): never {
    console.error(`extract: ${msg}`)
    process.exit(1)
}

function ensurePosthogPresent(): void {
    try {
        statSync(SCHEMA_DIR)
        statSync(GEN_TOOLS_DIR)
    } catch {
        die(
            `PostHog sources missing. Run \`npm run sync:posthog\` first to populate ./posthog/ at the pinned SHA.`
        )
    }
}

/**
 * Parse one `src/tools/generated/<product>.ts` file and return a map of
 * tool-name -> HTTP spec, derived from the generated factory bodies.
 *
 * Why regex rather than a TS AST: the generator in
 * services/mcp/scripts/generate-tools.ts emits a highly regular template.
 * Regex is ~20x less code and fixture tests catch any shape regressions.
 * If/when the generator gets less regular, swap to ts.createSourceFile.
 */
function parseGeneratedToolFile(source: string): Map<string, HttpSpec> {
    const out = new Map<string, HttpSpec>()

    // Split into factory blocks. Each factory:
    //   const <name> = (): ToolBase<...> => ({
    //       name: '<kebab-name>',
    //       schema: <Schema>,
    //       handler: async (...) => {
    //           ...
    //           const result = await context.api.request<...>({
    //               method: '<METHOD>',
    //               path: `<template>`,
    //               [query: { ... },]
    //               [body: { ... } | body,]
    //           })
    //           ...
    //       },
    //   })
    const factoryRe = /const\s+([a-zA-Z][a-zA-Z0-9]*)\s*=\s*\(\):\s*ToolBase</g
    const starts: number[] = []
    let m: RegExpExecArray | null
    while ((m = factoryRe.exec(source))) starts.push(m.index)
    starts.push(source.length)

    for (let i = 0; i < starts.length - 1; i++) {
        const startIdx = starts[i]!
        const endIdx = starts[i + 1]!
        const block = source.slice(startIdx, endIdx)

        const nameMatch = block.match(/\bname:\s*'([^']+)'/)
        if (!nameMatch) continue
        const toolName = nameMatch[1]!

        const methodMatch = block.match(/\bmethod:\s*'(GET|POST|PATCH|PUT|DELETE)'/)
        if (!methodMatch) continue
        const method = methodMatch[1] as HttpMethod

        // path is a template literal backtick-delimited
        const pathMatch = block.match(/\bpath:\s*`([^`]+)`/)
        if (!pathMatch) continue
        const pathTemplate = pathMatch[1]!

        const pathParams = extractPathParams(pathTemplate)
        const queryParams = extractQueryParams(block)
        const bodyParams = extractBodyParams(block)
        const normalizedPath = normalizePathTemplate(pathTemplate)

        out.set(toolName, {
            method,
            path: normalizedPath,
            pathParams,
            queryParams,
            bodyParams,
        })
    }

    return out
}

/**
 * Convert a generated template literal like
 *   /api/projects/${encodeURIComponent(String(projectId))}/feature_flags/${encodeURIComponent(String(params.id))}/
 * into
 *   /api/projects/{project_id}/feature_flags/{id}/
 *
 * The token `projectId` (no `params.` prefix) is always the implicit project id
 * sourced from context.stateManager.getProjectId(); everything under `params.X`
 * is a user-supplied path parameter.
 */
function normalizePathTemplate(tpl: string): string {
    return tpl.replace(
        /\$\{encodeURIComponent\(String\(([^)]+)\)\)\}/g,
        (_full, expr: string) => {
            const trimmed = expr.trim()
            if (trimmed === 'projectId') return '{project_id}'
            const paramMatch = trimmed.match(/^params\.([a-zA-Z_][a-zA-Z0-9_]*)$/)
            if (paramMatch) return `{${paramMatch[1]}}`
            return `{${trimmed}}`
        }
    )
}

function extractPathParams(tpl: string): string[] {
    const params: string[] = []
    const re = /\$\{encodeURIComponent\(String\(params\.([a-zA-Z_][a-zA-Z0-9_]*)\)\)\}/g
    let m: RegExpExecArray | null
    while ((m = re.exec(tpl))) params.push(m[1]!)
    return params
}

function extractQueryParams(block: string): string[] {
    const queryIdx = block.search(/\bquery:\s*\{/)
    if (queryIdx === -1) return []
    const openBrace = block.indexOf('{', queryIdx)
    const close = matchBrace(block, openBrace)
    if (close === -1) return []
    const body = block.slice(openBrace + 1, close)
    const params: string[] = []
    const re = /([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*params\.([a-zA-Z_][a-zA-Z0-9_]*)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(body))) {
        params.push(m[1]!)
    }
    return dedupe(params)
}

function extractBodyParams(block: string): string[] {
    // Pattern A: object literal body: { key: params.key, ... }
    const bodyObjIdx = block.search(/\bbody:\s*\{/)
    if (bodyObjIdx !== -1) {
        const openBrace = block.indexOf('{', bodyObjIdx)
        const close = matchBrace(block, openBrace)
        if (close !== -1) {
            const body = block.slice(openBrace + 1, close)
            const params: string[] = []
            const re = /([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*params\.([a-zA-Z_][a-zA-Z0-9_]*)/g
            let m: RegExpExecArray | null
            while ((m = re.exec(body))) params.push(m[1]!)
            if (params.length > 0) return dedupe(params)
        }
    }

    // Pattern B: conditional assignment
    //   const body: Record<string, unknown> = {}
    //   if (params.key !== undefined) { body['key'] = params.key }
    //   ...
    //   await context.api.request({ ..., body })
    const condRe = /body\[\s*'([a-zA-Z_][a-zA-Z0-9_]*)'\s*\]\s*=\s*params\.[a-zA-Z_][a-zA-Z0-9_]*/g
    const params: string[] = []
    let m: RegExpExecArray | null
    while ((m = condRe.exec(block))) params.push(m[1]!)
    return dedupe(params)
}

/** Given `source[openIdx]` is '{', return index of matching '}' or -1. */
function matchBrace(source: string, openIdx: number): number {
    let depth = 0
    for (let i = openIdx; i < source.length; i++) {
        const c = source[i]
        if (c === '{') depth++
        else if (c === '}') {
            depth--
            if (depth === 0) return i
        }
    }
    return -1
}

function dedupe<T>(arr: T[]): T[] {
    return Array.from(new Set(arr))
}

function loadToolDefinitions(): Record<string, ToolDefinitionAll> {
    const path = join(SCHEMA_DIR, 'tool-definitions-all.json')
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, ToolDefinitionAll>
}

function loadInputsSchemas(): Record<string, InputsSchema> {
    const path = join(SCHEMA_DIR, 'tool-inputs.json')
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { definitions?: Record<string, InputsSchema> }
    return raw.definitions ?? {}
}

/**
 * Walk handwritten tool TS files (services/mcp/src/tools/**, excluding generated/).
 * For each file with both a `name: '<kebab>'` literal and a
 * `import { <X>Schema } from '@/schema/tool-inputs'`, pair them up. Return
 * tool-name → schema-key mapping.
 */
function scanHandwrittenSchemas(): Map<string, string> {
    const mapping = new Map<string, string>()
    walk(HANDWRITTEN_TOOLS_DIR, (abs) => {
        if (abs.includes('/generated/')) return
        if (!abs.endsWith('.ts') || abs.endsWith('.test.ts') || abs.endsWith('.spec.ts')) return
        const src = readFileSync(abs, 'utf8')

        // Match imports of *Schema from tool-inputs
        const importRe = /import\s*\{([^}]+)\}\s*from\s*'@\/schema\/tool-inputs'/g
        const imported: string[] = []
        let im: RegExpExecArray | null
        while ((im = importRe.exec(src))) {
            for (const part of im[1]!.split(',')) {
                const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim()
                if (name) imported.push(name)
            }
        }
        if (imported.length === 0) return

        // Match every `name: 'kebab-name'` literal in the file. A factory file can
        // register multiple tools; we pair each name with the *single* imported
        // schema when only one is present.
        const nameRe = /\bname:\s*'([a-z][a-z0-9-]*)'/g
        const names: string[] = []
        let nm: RegExpExecArray | null
        while ((nm = nameRe.exec(src))) names.push(nm[1]!)

        if (names.length === 0) return

        if (imported.length === 1) {
            const schemaKey = imported[0]!
            for (const n of names) mapping.set(n, schemaKey)
            return
        }

        // Multi-import file: pair by proximity — for each name, pick the imported
        // schema whose camel form best matches the tool-name camel form.
        for (const n of names) {
            const best = bestSchemaMatch(n, imported)
            if (best) mapping.set(n, best)
        }
    })
    return mapping
}

function bestSchemaMatch(toolName: string, imports: string[]): string | null {
    const toolNorm = toolName.toLowerCase().replace(/-/g, '')
    let best: string | null = null
    let bestLen = 0
    for (const imp of imports) {
        const impNorm = imp.toLowerCase().replace(/schema$/, '').replace(/inputs?$/, '')
        if (impNorm.includes(toolNorm) || toolNorm.includes(impNorm)) {
            if (impNorm.length > bestLen) {
                best = imp
                bestLen = impNorm.length
            }
        }
    }
    return best
}

function walk(dir: string, visit: (abs: string) => void): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name)
        if (entry.isDirectory()) walk(abs, visit)
        else if (entry.isFile()) visit(abs)
    }
}

function walkGeneratedTools(): Map<string, HttpSpec> {
    const merged = new Map<string, HttpSpec>()
    for (const file of readdirSync(GEN_TOOLS_DIR)) {
        if (!file.endsWith('.ts') || file === 'index.ts') continue
        const full = join(GEN_TOOLS_DIR, file)
        const src = readFileSync(full, 'utf8')
        const specs = parseGeneratedToolFile(src)
        for (const [k, v] of specs) merged.set(k, v)
    }
    return merged
}

function build(): Registry {
    ensurePosthogPresent()
    const defs = loadToolDefinitions()
    const specs = walkGeneratedTools()
    const inputsSchemas = loadInputsSchemas()
    const handwrittenMap = scanHandwrittenSchemas()

    const tools: Record<string, RegistryTool> = {}
    const modules: Record<string, { title: string; tools: string[] }> = {}
    let missingHttpCount = 0
    let withInputsCount = 0

    for (const [toolName, def] of Object.entries(defs)) {
        const category = def.category ?? 'Misc'
        const slug = moduleSlug(category)
        const http = specs.get(toolName) ?? null
        if (!http) missingHttpCount++

        let inputs: InputsSchema | null = null
        if (!http) {
            const schemaKey = handwrittenMap.get(toolName)
            if (schemaKey && inputsSchemas[schemaKey]) {
                inputs = normalizeSchema(inputsSchemas[schemaKey]!)
                withInputsCount++
            }
        }

        tools[toolName] = {
            module: slug,
            category,
            title: def.title ?? def.summary ?? toolName,
            description: def.description ?? '',
            scopes: def.required_scopes ?? [],
            annotations: def.annotations ?? {},
            http,
            inputs,
        }

        if (!modules[slug]) modules[slug] = { title: category, tools: [] }
        modules[slug]!.tools.push(toolName)
    }

    for (const slug of Object.keys(modules)) {
        modules[slug]!.tools.sort()
    }

    const sha = readFileSync(SHA_FILE, 'utf8').trim()
    const registry: Registry = {
        posthogSha: sha,
        generatedAt: new Date().toISOString(),
        modules,
        tools,
    }

    console.error(
        `extract: ${Object.keys(tools).length} tools across ${Object.keys(modules).length} modules; ` +
            `${missingHttpCount - withInputsCount} handwritten without schema, ${withInputsCount} handwritten with per-field schema`
    )
    return registry
}

/** Drop fields the CLI doesn't use, shrinking registry.json. */
function normalizeSchema(raw: InputsSchema): InputsSchema {
    const out: InputsSchema = {}
    if (raw.type) out.type = raw.type
    if (raw.required) out.required = raw.required
    if (raw.properties) {
        out.properties = {}
        for (const [k, v] of Object.entries(raw.properties)) {
            out.properties[k] = {
                ...(v.type !== undefined ? { type: v.type } : {}),
                ...(v.description !== undefined ? { description: v.description } : {}),
                ...(v.default !== undefined ? { default: v.default } : {}),
                ...(v.enum !== undefined ? { enum: v.enum } : {}),
            }
        }
    }
    return out
}

function main(): void {
    const registry = build()
    writeFileSync(OUT, JSON.stringify(registry, null, 2) + '\n')
    console.error(`extract: wrote ${OUT}`)
}

// Only run when invoked as a script, not when imported from tests.
if (import.meta.url === `file://${process.argv[1]}`) {
    main()
}

export {
    parseGeneratedToolFile,
    normalizePathTemplate,
    extractPathParams,
    extractQueryParams,
    extractBodyParams,
    moduleSlug,
    build,
}
