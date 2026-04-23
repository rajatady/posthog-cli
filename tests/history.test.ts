import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

import { History, formatRelativeTime } from '../src/lib/history'

function freshDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'thehogcli-test-'))
    return join(dir, 'history.db')
}

describe('formatRelativeTime', () => {
    const now = new Date('2026-04-23T12:00:00Z').getTime()

    it('handles sub-second as "just now"', () => {
        expect(formatRelativeTime(now - 100, now)).toBe('just now')
    })

    it('formats seconds', () => {
        expect(formatRelativeTime(now - 5_000, now)).toBe('5 seconds ago')
    })

    it('formats minutes + seconds', () => {
        expect(formatRelativeTime(now - (3 * 60 + 4) * 1000, now)).toBe('3 minutes, 4 seconds ago')
    })

    it('formats hours + minutes', () => {
        expect(formatRelativeTime(now - (2 * 3600 + 15 * 60) * 1000, now)).toBe(
            '2 hours, 15 minutes ago'
        )
    })

    it('formats days + hours', () => {
        expect(formatRelativeTime(now - (23 * 86400 + 11 * 3600) * 1000, now)).toBe(
            '23 days, 11 hours ago'
        )
    })

    it('uses singular vs plural correctly', () => {
        expect(formatRelativeTime(now - 1000, now)).toBe('1 second ago')
        expect(formatRelativeTime(now - 86400 * 1000, now)).toBe('1 day ago')
    })
})

describe('History', () => {
    it('round-trips insert → list → get', () => {
        const h = new History(freshDbPath())

        h.insert({
            id: '00000000-0000-0000-0000-000000000001',
            createdAt: 1_700_000_000_000,
            module: 'feature-flags',
            tool: 'feature-flag-get-all',
            description: 'smoke test',
            params: { limit: 10, search: 'onboarding' },
            method: 'GET',
            path: '/api/projects/{project_id}/feature_flags/',
            responsePreview: '{ "results": [] }',
            exitCode: 0,
            durationMs: 42,
            forkedFrom: null,
        })

        const rows = h.list()
        expect(rows).toHaveLength(1)
        expect(rows[0]!.tool).toBe('feature-flag-get-all')
        expect(rows[0]!.params).toEqual({ limit: 10, search: 'onboarding' })
        expect(rows[0]!.method).toBe('GET')

        const byFull = h.get('00000000-0000-0000-0000-000000000001')
        expect(byFull?.description).toBe('smoke test')

        const byPrefix = h.get('00000000')
        expect(byPrefix?.id).toBe('00000000-0000-0000-0000-000000000001')
    })

    it('orders by created_at desc and paginates', () => {
        const h = new History(freshDbPath())
        for (let i = 0; i < 5; i++) {
            h.insert({
                id: `id-${i}`,
                createdAt: 1_700_000_000_000 + i * 1000,
                module: 'dashboards',
                tool: 'dashboard-get',
                description: `entry ${i}`,
                params: { id: String(i) },
                method: 'GET',
                path: '/',
                responsePreview: null,
                exitCode: 0,
                durationMs: 10,
                forkedFrom: null,
            })
        }
        const first = h.list({ limit: 2 })
        expect(first.map((e) => e.id)).toEqual(['id-4', 'id-3'])
        const second = h.list({ limit: 2, offset: 2 })
        expect(second.map((e) => e.id)).toEqual(['id-2', 'id-1'])
    })

    it('filters by module and tool', () => {
        const h = new History(freshDbPath())
        h.insert(mk({ id: 'a', module: 'feature-flags', tool: 'feature-flag-get-all' }))
        h.insert(mk({ id: 'b', module: 'dashboards', tool: 'dashboard-get' }))
        h.insert(mk({ id: 'c', module: 'feature-flags', tool: 'create-feature-flag' }))

        expect(h.list({ module: 'feature-flags' }).map((e) => e.id).sort()).toEqual(['a', 'c'])
        expect(h.list({ tool: 'dashboard-get' }).map((e) => e.id)).toEqual(['b'])
    })
})

function mk(overrides: Partial<Parameters<History['insert']>[0]>) {
    return {
        id: 'x',
        createdAt: Date.now(),
        module: 'm',
        tool: 't',
        description: 'd',
        params: {},
        method: 'GET' as const,
        path: '/',
        responsePreview: null,
        exitCode: 0,
        durationMs: 1,
        forkedFrom: null,
        ...overrides,
    }
}
