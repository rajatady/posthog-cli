import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

import {
    parseGeneratedToolFile,
    normalizePathTemplate,
    extractPathParams,
    extractQueryParams,
    extractBodyParams,
    moduleSlug,
    build,
} from '../build/extract'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(__dirname, 'fixtures/mcp/feature_flags.sample.ts')

describe('moduleSlug', () => {
    it('converts category to kebab slug', () => {
        expect(moduleSlug('Feature flags')).toBe('feature-flags')
        expect(moduleSlug('Error tracking')).toBe('error-tracking')
        expect(moduleSlug('Organization & project management')).toBe(
            'organization-and-project-management'
        )
        expect(moduleSlug('LLM analytics')).toBe('llm-analytics')
    })
})

describe('normalizePathTemplate', () => {
    it('rewrites projectId and params.* into {template} placeholders', () => {
        const tpl =
            '/api/projects/${encodeURIComponent(String(projectId))}/feature_flags/${encodeURIComponent(String(params.id))}/'
        expect(normalizePathTemplate(tpl)).toBe('/api/projects/{project_id}/feature_flags/{id}/')
    })

    it('leaves plain paths untouched', () => {
        expect(normalizePathTemplate('/api/projects/{project_id}/feature_flags/')).toBe(
            '/api/projects/{project_id}/feature_flags/'
        )
    })
})

describe('extractPathParams', () => {
    it('returns only user-supplied params, not projectId', () => {
        const tpl =
            '/api/projects/${encodeURIComponent(String(projectId))}/feature_flags/${encodeURIComponent(String(params.id))}/'
        expect(extractPathParams(tpl)).toEqual(['id'])
    })

    it('returns empty when no params', () => {
        expect(
            extractPathParams('/api/projects/${encodeURIComponent(String(projectId))}/feature_flags/')
        ).toEqual([])
    })
})

describe('extractQueryParams', () => {
    it('extracts params from inline query object', () => {
        const block = `
            await context.api.request({
                method: 'GET',
                path: \`/api/x/\`,
                query: {
                    active: params.active,
                    limit: params.limit,
                    search: params.search,
                },
            })
        `
        expect(extractQueryParams(block).sort()).toEqual(['active', 'limit', 'search'])
    })

    it('returns [] when no query block present', () => {
        expect(extractQueryParams("method: 'POST', path: `/x/`, body")).toEqual([])
    })
})

describe('extractBodyParams', () => {
    it('extracts params from conditional-assignment body pattern', () => {
        const block = `
            const body: Record<string, unknown> = {}
            if (params.key !== undefined) { body['key'] = params.key }
            if (params.name !== undefined) { body['name'] = params.name }
            await context.api.request({ method: 'POST', path: \`/x/\`, body })
        `
        expect(extractBodyParams(block).sort()).toEqual(['key', 'name'])
    })

    it('extracts params from inline body object', () => {
        const block = `
            await context.api.request({
                method: 'POST',
                path: \`/x/\`,
                body: { foo: params.foo, bar: params.bar },
            })
        `
        expect(extractBodyParams(block).sort()).toEqual(['bar', 'foo'])
    })

    it('returns [] when no body', () => {
        expect(extractBodyParams("method: 'GET'")).toEqual([])
    })
})

describe('parseGeneratedToolFile (integration on real MCP fixture shape)', () => {
    const src = readFileSync(FIXTURE, 'utf8')
    const specs = parseGeneratedToolFile(src)

    it('discovers all five sample factories', () => {
        expect([...specs.keys()].sort()).toEqual([
            'create-feature-flag',
            'delete-feature-flag',
            'feature-flag-get-all',
            'feature-flag-get-definition',
            'update-feature-flag',
        ])
    })

    it('maps GET list with query params', () => {
        const s = specs.get('feature-flag-get-all')!
        expect(s.method).toBe('GET')
        expect(s.path).toBe('/api/projects/{project_id}/feature_flags/')
        expect(s.pathParams).toEqual([])
        expect(s.queryParams.sort()).toEqual([
            'active',
            'created_by_id',
            'limit',
            'offset',
            'search',
            'tags',
        ])
        expect(s.bodyParams).toEqual([])
    })

    it('maps GET by id with path param', () => {
        const s = specs.get('feature-flag-get-definition')!
        expect(s.method).toBe('GET')
        expect(s.path).toBe('/api/projects/{project_id}/feature_flags/{id}/')
        expect(s.pathParams).toEqual(['id'])
        expect(s.queryParams).toEqual([])
        expect(s.bodyParams).toEqual([])
    })

    it('maps POST with conditional body', () => {
        const s = specs.get('create-feature-flag')!
        expect(s.method).toBe('POST')
        expect(s.path).toBe('/api/projects/{project_id}/feature_flags/')
        expect(s.pathParams).toEqual([])
        expect(s.bodyParams.sort()).toEqual(['active', 'filters', 'key', 'name'])
    })

    it('maps PATCH with path param and conditional body', () => {
        const s = specs.get('update-feature-flag')!
        expect(s.method).toBe('PATCH')
        expect(s.path).toBe('/api/projects/{project_id}/feature_flags/{id}/')
        expect(s.pathParams).toEqual(['id'])
        expect(s.bodyParams.sort()).toEqual(['key', 'name'])
    })

    it('maps DELETE with path param and no body', () => {
        const s = specs.get('delete-feature-flag')!
        expect(s.method).toBe('DELETE')
        expect(s.pathParams).toEqual(['id'])
        expect(s.bodyParams).toEqual([])
        expect(s.queryParams).toEqual([])
    })
})

const POSTHOG_PRESENT = existsSync(join(dirname(fileURLToPath(import.meta.url)), '../posthog/services/mcp/schema/tool-definitions-all.json'))

describe.skipIf(!POSTHOG_PRESENT)('build() pipeline integration (requires posthog/ clone)', () => {
    it('produces a registry with 262 tools', () => {
        const registry = build()
        expect(Object.keys(registry.tools).length).toBe(262)
    })

    it('all tools have module, title, scopes', () => {
        const registry = build()
        for (const [name, tool] of Object.entries(registry.tools)) {
            expect(tool.module, `${name}.module`).toBeTruthy()
            expect(tool.title, `${name}.title`).toBeTruthy()
            expect(Array.isArray(tool.scopes), `${name}.scopes`).toBe(true)
        }
    })

    it('every tool in each module maps back to an existing tool entry', () => {
        const registry = build()
        for (const [slug, mod] of Object.entries(registry.modules)) {
            for (const toolName of mod.tools) {
                expect(registry.tools[toolName], `${slug}/${toolName}`).toBeDefined()
            }
        }
    })

    it('posthogSha is a 40-char hex string', () => {
        const registry = build()
        expect(registry.posthogSha).toMatch(/^[0-9a-f]{40}$/)
    })

    it('231 tools have HTTP specs; 31 are handwritten', () => {
        const registry = build()
        const withHttp = Object.values(registry.tools).filter(t => t.http !== null)
        const handwritten = Object.values(registry.tools).filter(t => t.http === null)
        expect(withHttp.length).toBe(231)
        expect(handwritten.length).toBe(31)
    })

    it('output matches the checked-in registry.json', () => {
        const registry = build()
        const onDisk = JSON.parse(
            readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/registry.json'), 'utf8')
        ) as typeof registry
        expect(Object.keys(registry.tools).sort()).toEqual(Object.keys(onDisk.tools).sort())
        expect(Object.keys(registry.modules).sort()).toEqual(Object.keys(onDisk.modules).sort())
    })
})
