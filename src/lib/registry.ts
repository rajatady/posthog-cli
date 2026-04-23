import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

export interface HttpSpec {
    method: HttpMethod
    path: string
    pathParams: string[]
    queryParams: string[]
    bodyParams: string[]
}

export interface InputSchemaProperty {
    type?: string | string[]
    description?: string
    default?: unknown
    enum?: unknown[]
}

export interface InputsSchema {
    type?: string
    required?: string[]
    properties?: Record<string, InputSchemaProperty>
}

export interface RegistryTool {
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

export interface RegistryModule {
    title: string
    tools: string[]
}

export interface Registry {
    posthogSha: string
    generatedAt: string
    modules: Record<string, RegistryModule>
    tools: Record<string, RegistryTool>
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const REGISTRY_PATH = resolve(__dirname, '../registry.json')

let cached: Registry | null = null

export function loadRegistry(path: string = REGISTRY_PATH): Registry {
    if (cached && path === REGISTRY_PATH) return cached
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as Registry
    if (path === REGISTRY_PATH) cached = parsed
    return parsed
}

export function getTool(registry: Registry, name: string): RegistryTool | undefined {
    return registry.tools[name]
}

/** True when the tool is one of the 31 handwritten v1 wrappers (no HTTP spec extracted). */
export function isUnextractable(tool: RegistryTool): boolean {
    return tool.http === null
}

export function isDestructive(tool: RegistryTool): boolean {
    const a = tool.annotations as { destructiveHint?: boolean }
    return a.destructiveHint === true
}
