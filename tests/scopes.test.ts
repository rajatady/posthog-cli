import { describe, it, expect } from 'vitest'

import { loadRegistry, getTool } from '../src/lib/registry'
import { deriveAllScopes, deriveReadScopes } from '../src/lib/scopes'

/**
 * The scope set thehogcli asks for at login is derived, not maintained by hand.
 * These tests pin the shape so that:
 *  - a registry regeneration that accidentally drops scopes surfaces immediately
 *  - a scope typo (e.g. 'feature_flag:red') doesn't silently leak into a release
 */
describe('getTool', () => {
    const registry = loadRegistry()

    it('returns the tool entry for a known tool name', () => {
        const tool = getTool(registry, 'feature-flag-get-all')
        expect(tool).toBeDefined()
        expect(tool?.module).toBe('feature-flags')
    })

    it('returns undefined for an unknown tool name', () => {
        expect(getTool(registry, 'nonexistent-tool-xyz')).toBeUndefined()
    })
})

describe('deriveAllScopes', () => {
    const registry = loadRegistry()
    const all = deriveAllScopes(registry)

    it('returns a sorted, deduplicated list', () => {
        expect(all).toEqual([...new Set(all)].sort())
    })

    it('every entry is <object>:<read|write>', () => {
        for (const s of all) {
            expect(s).toMatch(/^[a-z][a-z0-9_]*:(read|write)$/)
        }
    })

    it('covers the canonical high-traffic scopes', () => {
        const required = [
            'feature_flag:read',
            'feature_flag:write',
            'dashboard:read',
            'insight:read',
            'experiment:read',
            'cohort:read',
            'survey:read',
            'error_tracking:read',
        ]
        for (const r of required) expect(all).toContain(r)
    })

    it('does not include invented scopes', () => {
        expect(all).not.toContain('all')
        expect(all).not.toContain('admin')
        expect(all).not.toContain('root:*')
    })
})

describe('deriveReadScopes', () => {
    const registry = loadRegistry()
    const reads = deriveReadScopes(registry)

    it('contains only :read entries', () => {
        for (const s of reads) expect(s.endsWith(':read')).toBe(true)
    })

    it('is a strict subset of deriveAllScopes', () => {
        const all = new Set(deriveAllScopes(registry))
        for (const s of reads) expect(all.has(s)).toBe(true)
    })
})
