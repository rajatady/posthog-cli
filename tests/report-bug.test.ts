import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/lib/config.js', () => ({ loadConfig: vi.fn() }))
vi.mock('../src/lib/history.js', () => ({
    resolveHistoryPath: vi.fn().mockReturnValue('/tmp/test.db'),
    History: vi.fn(),
}))
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }))

import { spawnSync } from 'node:child_process'
import { Command } from 'commander'
import { loadConfig } from '../src/lib/config.js'
import { History } from '../src/lib/history.js'
import { registerReportBugCommand } from '../src/commands/report-bug.js'

const mockLoadConfig = loadConfig as ReturnType<typeof vi.fn>
const MockHistory = History as ReturnType<typeof vi.fn>
const mockSpawn = spawnSync as ReturnType<typeof vi.fn>

function baseConfig() {
    return {
        host: 'https://us.posthog.com',
        apiKey: 'phx_test',
        projectId: '42',
        orgId: null,
        refreshToken: null,
        clientId: null,
        expiresAt: null,
    }
}

function makeEntry(overrides = {}) {
    return {
        id: 'aaaabbbb-1234-5678-9abc-def012345678',
        createdAt: Date.parse('2026-01-01T10:00:00Z'),
        module: 'feature-flags',
        tool: 'feature-flag-get-all',
        description: 'checking flags',
        params: { limit: 5 },
        method: 'GET',
        path: '/api/projects/{project_id}/feature_flags/',
        responsePreview: '{"results":[]}',
        exitCode: 0,
        durationMs: 123,
        forkedFrom: null,
        ...overrides,
    }
}

async function runCmd(args: string[]): Promise<{ stdout: string[]; stderr: string[] }> {
    const logged: string[] = []
    const errors: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a) => logged.push(a.join(' ')))
    vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a.join(' ')))

    const program = new Command()
    program.exitOverride()
    registerReportBugCommand(program)

    try {
        await program.parseAsync(['node', 'test', ...args])
    } catch {
        // commander throws on exitOverride
    }

    return { stdout: logged, stderr: errors }
}

describe('report-bug', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        process.exitCode = 0
        mockLoadConfig.mockReturnValue(baseConfig())
    })

    it('opens browser with pre-filled URL containing version and host', async () => {
        const mockList = vi.fn().mockReturnValue([makeEntry()])
        MockHistory.mockImplementation(() => ({ list: mockList, get: vi.fn() }))

        const { stderr } = await runCmd(['report-bug', '--title', 'my bug'])

        expect(mockSpawn).toHaveBeenCalledOnce()
        const url = (mockSpawn.mock.calls[0] as unknown[])[1] as string[]
        const fullUrl = url[url.length - 1]!
        expect(fullUrl).toContain('github.com/rajatady/posthog-cli/issues/new')
        expect(fullUrl).toContain(encodeURIComponent('my bug'))
        expect(fullUrl).toContain(encodeURIComponent('feature-flag-get-all'))
        expect(stderr.join(' ')).toContain('Opening GitHub issue form')
    })

    it('uses @current when projectId is null', async () => {
        mockLoadConfig.mockReturnValue({ ...baseConfig(), projectId: null })
        MockHistory.mockImplementation(() => ({ list: vi.fn().mockReturnValue([]), get: vi.fn() }))

        await runCmd(['report-bug'])

        const url = (mockSpawn.mock.calls[0] as unknown[])[1] as string[]
        const fullUrl = url[url.length - 1]!
        expect(fullUrl).toContain(encodeURIComponent('@current'))
    })

    it('uses --last N to fetch N history entries', async () => {
        const mockList = vi.fn().mockReturnValue([])
        MockHistory.mockImplementation(() => ({ list: mockList, get: vi.fn() }))

        await runCmd(['report-bug', '--last', '10'])

        expect(mockList).toHaveBeenCalledWith({ limit: 10 })
    })

    it('shows placeholder when no history entries exist', async () => {
        MockHistory.mockImplementation(() => ({ list: vi.fn().mockReturnValue([]), get: vi.fn() }))

        await runCmd(['report-bug'])

        const url = (mockSpawn.mock.calls[0] as unknown[])[1] as string[]
        const fullUrl = url[url.length - 1]!
        expect(decodeURIComponent(fullUrl)).toContain('no history entries found')
    })

    it('attaches specific entry when --id is provided', async () => {
        const entry = makeEntry()
        const mockGet = vi.fn().mockReturnValue(entry)
        MockHistory.mockImplementation(() => ({ list: vi.fn(), get: mockGet }))

        await runCmd(['report-bug', '--id', 'aaaabbbb'])

        expect(mockGet).toHaveBeenCalledWith('aaaabbbb')
        const url = (mockSpawn.mock.calls[0] as unknown[])[1] as string[]
        expect(url[url.length - 1]).toContain(encodeURIComponent('feature-flag-get-all'))
    })

    it('prints error and sets exitCode 1 when --id entry not found', async () => {
        MockHistory.mockImplementation(() => ({ list: vi.fn(), get: vi.fn().mockReturnValue(null) }))

        const { stderr } = await runCmd(['report-bug', '--id', 'notfound'])

        expect(stderr.join(' ')).toContain('No history entry matching "notfound"')
        expect(process.exitCode).toBe(1)
    })

    it('falls back gracefully when history throws', async () => {
        MockHistory.mockImplementation(() => { throw new Error('db error') })

        await runCmd(['report-bug'])

        const url = (mockSpawn.mock.calls[0] as unknown[])[1] as string[]
        expect(decodeURIComponent(url[url.length - 1]!)).toContain('history unavailable')
    })

    it('includes default title placeholder when --title is not provided', async () => {
        MockHistory.mockImplementation(() => ({ list: vi.fn().mockReturnValue([]), get: vi.fn() }))

        await runCmd(['report-bug'])

        const url = (mockSpawn.mock.calls[0] as unknown[])[1] as string[]
        const fullUrl = url[url.length - 1]!
        expect(decodeURIComponent(fullUrl)).toContain('[FILL IN: one-line description of the bug]')
    })

    it('shows exit code for failed entries', async () => {
        const entry = makeEntry({ exitCode: 1 })
        MockHistory.mockImplementation(() => ({ list: vi.fn().mockReturnValue([entry]), get: vi.fn() }))

        await runCmd(['report-bug'])

        const url = (mockSpawn.mock.calls[0] as unknown[])[1] as string[]
        expect(decodeURIComponent(url[url.length - 1]!)).toContain('exit 1')
    })

    it('formats entry without method/path gracefully', async () => {
        const entry = makeEntry({ method: null, path: null, params: {}, responsePreview: null })
        MockHistory.mockImplementation(() => ({ list: vi.fn().mockReturnValue([entry]), get: vi.fn() }))

        await runCmd(['report-bug'])

        const url = (mockSpawn.mock.calls[0] as unknown[])[1] as string[]
        // should not throw and URL should still be valid
        expect(url[url.length - 1]).toContain('github.com')
    })

    it('truncates long response previews in the issue body', async () => {
        const longPreview = 'x'.repeat(500)
        const entry = makeEntry({ responsePreview: longPreview })
        MockHistory.mockImplementation(() => ({ list: vi.fn().mockReturnValue([entry]), get: vi.fn() }))

        await runCmd(['report-bug'])

        const url = (mockSpawn.mock.calls[0] as unknown[])[1] as string[]
        const body = decodeURIComponent(url[url.length - 1]!.split('body=')[1]!)
        // preview in body must be ≤ 300 chars + ellipsis, not the full 500
        expect(body).not.toContain('x'.repeat(400))
    })

    it('silently continues when spawnSync throws', async () => {
        MockHistory.mockImplementation(() => ({ list: vi.fn().mockReturnValue([]), get: vi.fn() }))
        mockSpawn.mockImplementationOnce(() => { throw new Error('no open binary') })

        // Should not throw
        await runCmd(['report-bug'])
    })

    it('uses darwin open command on macOS', async () => {
        const originalPlatform = process.platform
        Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
        MockHistory.mockImplementation(() => ({ list: vi.fn().mockReturnValue([]), get: vi.fn() }))

        await runCmd(['report-bug'])

        expect((mockSpawn.mock.calls[0] as unknown[])[0]).toBe('open')
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    })

    it('uses xdg-open on linux', async () => {
        const originalPlatform = process.platform
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
        MockHistory.mockImplementation(() => ({ list: vi.fn().mockReturnValue([]), get: vi.fn() }))

        await runCmd(['report-bug'])

        expect((mockSpawn.mock.calls[0] as unknown[])[0]).toBe('xdg-open')
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    })

    it('uses cmd /C start on windows', async () => {
        const originalPlatform = process.platform
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
        MockHistory.mockImplementation(() => ({ list: vi.fn().mockReturnValue([]), get: vi.fn() }))

        await runCmd(['report-bug'])

        expect((mockSpawn.mock.calls[0] as unknown[])[0]).toBe('cmd')
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    })
})
