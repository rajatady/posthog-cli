import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'

vi.mock('undici', () => ({ fetch: vi.fn() }))
vi.mock('../src/lib/config.js', () => ({
    loadConfig: vi.fn(),
    saveConfig: vi.fn(),
    configPath: vi.fn().mockReturnValue('/tmp/.thehogcli/config.json'),
}))
vi.mock('../src/lib/api.js', () => ({
    resolveRequest: vi.fn(),
    executeRequest: vi.fn(),
    redactHeaders: vi.fn((h: Record<string, string>) => ({ ...h, Authorization: 'Bearer <redacted>' })),
    toKebab: (s: string) => s.replace(/_/g, '-'),
    fromKebab: (s: string) => s.replace(/-/g, '_'),
}))

import { fetch } from 'undici'
import { loadConfig } from '../src/lib/config.js'
import { executeRequest, resolveRequest } from '../src/lib/api.js'
import { registerToolCommand } from '../src/commands/tool.js'
import type { RegistryTool } from '../src/lib/registry.js'

const mockFetch = fetch as ReturnType<typeof vi.fn>
const mockLoadConfig = loadConfig as ReturnType<typeof vi.fn>
const mockExecuteRequest = executeRequest as ReturnType<typeof vi.fn>
const mockResolveRequest = resolveRequest as ReturnType<typeof vi.fn>

let tmpDir: string

const fakeConfig = {
    host: 'https://us.posthog.com',
    apiKey: 'phx_test',
    refreshToken: null,
    clientId: null,
    expiresAt: null,
    projectId: '12345',
    orgId: null,
}

const httpTool: RegistryTool = {
    module: 'feature-flags',
    category: 'feature_flags',
    title: 'Get all feature flags',
    description: 'List feature flags',
    scopes: ['feature_flag:read'],
    annotations: {},
    http: {
        method: 'GET',
        path: '/api/projects/{project_id}/feature_flags/',
        pathParams: [],
        queryParams: ['limit', 'search'],
        bodyParams: [],
    },
    inputs: null,
}

const postTool: RegistryTool = {
    module: 'feature-flags',
    category: 'feature_flags',
    title: 'Create feature flag',
    description: 'Create a feature flag',
    scopes: ['feature_flag:write'],
    annotations: { destructiveHint: true },
    http: {
        method: 'POST',
        path: '/api/projects/{project_id}/feature_flags/',
        pathParams: [],
        queryParams: [],
        bodyParams: ['name', 'key'],
    },
    inputs: null,
}

const handwrittenTool: RegistryTool = {
    module: 'ai',
    category: 'posthog_ai',
    title: 'Execute SQL',
    description: 'Run HogQL',
    scopes: ['query:read'],
    annotations: {},
    http: null,
    inputs: {
        properties: {
            query: { type: 'string', description: 'SQL query' },
        },
        required: ['query'],
    },
}

function makeCmd(toolName: string, tool: RegistryTool): Command {
    const program = new Command().exitOverride()
    registerToolCommand(program, { toolName, tool })
    return program
}

async function parse(cmd: Command, args: string[]): Promise<void> {
    await cmd.parseAsync(args, { from: 'user' })
}

describe('registerToolCommand – flag naming', () => {
    it('converts snake_case query params to kebab flags', () => {
        const program = new Command()
        const tool: RegistryTool = {
            ...httpTool,
            http: { ...httpTool.http!, queryParams: ['group_type_index', 'id__in'] },
        }
        const cmd = registerToolCommand(program, { toolName: 'test-tool', tool })
        const flags = cmd.options.map((o) => o.long)
        expect(flags).toContain('--group-type-index')
        expect(flags).toContain('--id-in')
    })

    it('converts camelCase handwritten schema props to kebab flags', () => {
        const program = new Command()
        const tool: RegistryTool = {
            ...handwrittenTool,
            inputs: { properties: { insightId: { type: 'string' }, groupTypeIndex: { type: 'number' } } },
        }
        const cmd = registerToolCommand(program, { toolName: 'test-tool', tool })
        const flags = cmd.options.map((o) => o.long)
        expect(flags).toContain('--insight-id')
        expect(flags).toContain('--group-type-index')
    })

    it('does not register --project-id for a tool that declares projectId', () => {
        const program = new Command()
        const tool: RegistryTool = {
            ...handwrittenTool,
            inputs: { properties: { projectId: { type: 'number' }, query: { type: 'string' } } },
        }
        const cmd = registerToolCommand(program, { toolName: 'test-tool', tool })
        const projectIdFlags = cmd.options.filter((o) => o.long === '--project-id')
        // Only the top-level reserved --project-id should exist, not a duplicate
        expect(projectIdFlags).toHaveLength(1)
    })

    it('handwritten tool with no inputs schema only has --args flag', () => {
        const program = new Command()
        const tool: RegistryTool = { ...handwrittenTool, inputs: null }
        const cmd = registerToolCommand(program, { toolName: 'test-tool', tool })
        const flags = cmd.options.map((o) => o.long)
        expect(flags).toContain('--args')
        expect(flags).not.toContain('--query')
    })

    it('marks unextractable tools with [v1 / handwritten] prefix in description', () => {
        const program = new Command()
        const tool: RegistryTool = { ...handwrittenTool, inputs: null }
        const cmd = registerToolCommand(program, { toolName: 'test-tool', tool })
        expect(cmd.description()).toContain('[v1 / handwritten')
    })
})

describe('runTool – missing --why', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        tmpDir = mkdtempSync(join(tmpdir(), 'thehogcli-test-'))
        process.env.THEHOGCLI_HISTORY_DB = join(tmpDir, 'test.db')
        mockLoadConfig.mockReturnValue(fakeConfig)
    })
    afterEach(() => {
        delete process.env.THEHOGCLI_HISTORY_DB
        rmSync(tmpDir, { recursive: true, force: true })
    })

    it('exits with code 1 and prints error when --why is absent', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const cmd = makeCmd('feature-flag-get-all', httpTool)
        await parse(cmd, ['feature-flag-get-all'])
        expect(process.exitCode).toBe(1)
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('--why'))
        consoleSpy.mockRestore()
        process.exitCode = 0
    })
})

describe('runTool – dry-run', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        tmpDir = mkdtempSync(join(tmpdir(), 'thehogcli-test-'))
        process.env.THEHOGCLI_HISTORY_DB = join(tmpDir, 'test.db')
        mockLoadConfig.mockReturnValue(fakeConfig)
        mockResolveRequest.mockReturnValue({
            method: 'GET',
            url: 'https://us.posthog.com/api/projects/12345/feature_flags/',
            headers: { Authorization: 'Bearer phx_test', Accept: 'application/json', 'User-Agent': 'thehogcli/1.x' },
            body: null,
        })
    })
    afterEach(() => {
        delete process.env.THEHOGCLI_HISTORY_DB
        rmSync(tmpDir, { recursive: true, force: true })
        process.exitCode = 0
    })

    it('prints DRY RUN and does not call executeRequest', async () => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const cmd = makeCmd('feature-flag-get-all', httpTool)
        await parse(cmd, ['feature-flag-get-all', '--why', 'testing', '--dry-run'])
        expect(mockExecuteRequest).not.toHaveBeenCalled()
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('DRY RUN'))
        consoleSpy.mockRestore()
        errSpy.mockRestore()
    })

    it('dry-run for handwritten tool also skips fetch', async () => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const cmd = makeCmd('execute-sql', handwrittenTool)
        await parse(cmd, ['execute-sql', '--why', 'testing', '--dry-run', '--query', 'SELECT 1'])
        expect(mockFetch).not.toHaveBeenCalled()
        consoleSpy.mockRestore()
        errSpy.mockRestore()
    })
})

describe('runTool – live execution', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        tmpDir = mkdtempSync(join(tmpdir(), 'thehogcli-test-'))
        process.env.THEHOGCLI_HISTORY_DB = join(tmpDir, 'test.db')
        mockLoadConfig.mockReturnValue(fakeConfig)
        mockResolveRequest.mockReturnValue({
            method: 'GET',
            url: 'https://us.posthog.com/api/projects/12345/feature_flags/',
            headers: { Authorization: 'Bearer phx_test', Accept: 'application/json', 'User-Agent': 'thehogcli/1.x' },
            body: null,
        })
    })
    afterEach(() => {
        delete process.env.THEHOGCLI_HISTORY_DB
        rmSync(tmpDir, { recursive: true, force: true })
        process.exitCode = 0
    })

    it('executes standard tool and writes history on success', async () => {
        mockExecuteRequest.mockResolvedValueOnce({
            status: 200,
            body: { results: [], count: 0 },
            durationMs: 42,
        })
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const cmd = makeCmd('feature-flag-get-all', httpTool)
        await parse(cmd, ['feature-flag-get-all', '--why', 'checking flags', '--limit', '5'])
        expect(mockExecuteRequest).toHaveBeenCalledOnce()
        expect(process.exitCode).toBeFalsy()
        consoleSpy.mockRestore()
        errSpy.mockRestore()
    })

    it('sets exitCode 1 on HTTP error response', async () => {
        mockExecuteRequest.mockResolvedValueOnce({ status: 403, body: { detail: 'forbidden' }, durationMs: 10 })
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const cmd = makeCmd('feature-flag-get-all', httpTool)
        await parse(cmd, ['feature-flag-get-all', '--why', 'test'])
        expect(process.exitCode).toBe(1)
        consoleSpy.mockRestore()
        errSpy.mockRestore()
    })

    it('prints JSON when --json flag is set', async () => {
        mockExecuteRequest.mockResolvedValueOnce({ status: 200, body: { count: 5 }, durationMs: 10 })
        const logged: unknown[] = []
        vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(args[0]) })
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const cmd = makeCmd('feature-flag-get-all', httpTool)
        await parse(cmd, ['feature-flag-get-all', '--why', 'test', '--json'])
        expect(logged.some(l => typeof l === 'string' && l.includes('"count"'))).toBe(true)
    })

    it('suppresses history id line on stderr when --json is set', async () => {
        mockExecuteRequest.mockResolvedValueOnce({ status: 200, body: { count: 5 }, durationMs: 10 })
        const errLogs: string[] = []
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation((...args) => { errLogs.push(String(args[0])) })
        const cmd = makeCmd('feature-flag-get-all', httpTool)
        await parse(cmd, ['feature-flag-get-all', '--why', 'test', '--json'])
        expect(errLogs.every(l => !l.includes('history id'))).toBe(true)
    })

    it('prints history id line on stderr when --json is not set', async () => {
        mockExecuteRequest.mockResolvedValueOnce({ status: 200, body: { count: 5 }, durationMs: 10 })
        const errLogs: string[] = []
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation((...args) => { errLogs.push(String(args[0])) })
        const cmd = makeCmd('feature-flag-get-all', httpTool)
        await parse(cmd, ['feature-flag-get-all', '--why', 'test'])
        expect(errLogs.some(l => l.includes('history id'))).toBe(true)
    })

    it('warns on destructive tool and proceeds', async () => {
        mockExecuteRequest.mockResolvedValueOnce({ status: 200, body: {}, durationMs: 5 })
        const errLogs: string[] = []
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation((...args) => { errLogs.push(String(args[0])) })
        const cmd = makeCmd('feature-flag-delete', postTool)
        await parse(cmd, ['feature-flag-delete', '--why', 'cleanup'])
        expect(errLogs.some(l => l.includes('destructive'))).toBe(true)
    })

    it('overrides projectId from --project-id flag', async () => {
        mockExecuteRequest.mockResolvedValueOnce({ status: 200, body: {}, durationMs: 5 })
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})
        mockLoadConfig.mockReturnValue({ ...fakeConfig, projectId: null })
        const cmd = makeCmd('feature-flag-get-all', httpTool)
        await parse(cmd, ['feature-flag-get-all', '--why', 'test', '--project-id', '99999'])
        const cfg = mockResolveRequest.mock.calls[0]?.[0] as { projectId: string } | undefined
        expect(cfg?.projectId).toBe('99999')
    })

    it('handles thrown exception from executeRequest gracefully', async () => {
        mockExecuteRequest.mockRejectedValueOnce(new Error('network down'))
        const errLogs: string[] = []
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation((...args) => { errLogs.push(String(args[0])) })
        const cmd = makeCmd('feature-flag-get-all', httpTool)
        await parse(cmd, ['feature-flag-get-all', '--why', 'test'])
        expect(process.exitCode).toBe(1)
        expect(errLogs.some(l => l.includes('network down'))).toBe(true)
    })
})

describe('runTool – handwritten tool execution', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        tmpDir = mkdtempSync(join(tmpdir(), 'thehogcli-test-'))
        process.env.THEHOGCLI_HISTORY_DB = join(tmpDir, 'test.db')
        mockLoadConfig.mockReturnValue(fakeConfig)
    })
    afterEach(() => {
        delete process.env.THEHOGCLI_HISTORY_DB
        rmSync(tmpDir, { recursive: true, force: true })
        process.exitCode = 0
    })

    it('POSTs to mcp_tools endpoint with args', async () => {
        mockFetch.mockResolvedValueOnce({
            status: 200,
            text: async () => JSON.stringify({ success: true, content: 'row count: 5' }),
        })
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const cmd = makeCmd('execute-sql', handwrittenTool)
        await parse(cmd, ['execute-sql', '--why', 'count rows', '--query', 'SELECT count() FROM events'])
        expect(mockFetch).toHaveBeenCalledOnce()
        const [url, init] = mockFetch.mock.calls[0] as [string, { body: string }]
        expect(url).toContain('mcp_tools/execute_sql/')
        const body = JSON.parse(init.body)
        expect(body.args.query).toBe('SELECT count() FROM events')
    })

    it('throws when apiKey is missing for handwritten tool', async () => {
        mockLoadConfig.mockReturnValue({ ...fakeConfig, apiKey: null })
        const errLogs: string[] = []
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation((...args) => { errLogs.push(String(args[0])) })
        const cmd = makeCmd('execute-sql', handwrittenTool)
        await parse(cmd, ['execute-sql', '--why', 'test', '--query', 'SELECT 1'])
        expect(process.exitCode).toBe(1)
        expect(errLogs.some(l => l.includes('Missing API key'))).toBe(true)
    })

    it('merges --args JSON on top of per-field flags', async () => {
        mockFetch.mockResolvedValueOnce({
            status: 200,
            text: async () => JSON.stringify({ success: true, content: 'ok' }),
        })
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const cmd = makeCmd('execute-sql', handwrittenTool)
        await parse(cmd, ['execute-sql', '--why', 'test', '--query', 'SELECT 1', '--args', '{"extra":"val"}'])
        const [, init] = mockFetch.mock.calls[0] as [string, { body: string }]
        const body = JSON.parse(init.body)
        expect(body.args.query).toBe('SELECT 1')
        expect(body.args.extra).toBe('val')
    })

    it('prints JSON when --json flag is set for handwritten tool', async () => {
        mockFetch.mockResolvedValueOnce({
            status: 200,
            text: async () => JSON.stringify({ success: true, content: 'data' }),
        })
        const logged: unknown[] = []
        vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(args[0]) })
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const cmd = makeCmd('execute-sql', handwrittenTool)
        await parse(cmd, ['execute-sql', '--why', 'test', '--query', 'SELECT 1', '--json'])
        expect(logged.some(l => typeof l === 'string' && l.includes('success'))).toBe(true)
    })
})

describe('printResult – string body', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        tmpDir = mkdtempSync(join(tmpdir(), 'thehogcli-test-'))
        process.env.THEHOGCLI_HISTORY_DB = join(tmpDir, 'test.db')
        mockLoadConfig.mockReturnValue(fakeConfig)
        mockResolveRequest.mockReturnValue({
            method: 'GET',
            url: 'https://us.posthog.com/api/test/',
            headers: {},
            body: null,
        })
    })
    afterEach(() => {
        delete process.env.THEHOGCLI_HISTORY_DB
        rmSync(tmpDir, { recursive: true, force: true })
        process.exitCode = 0
    })

    it('logs string body directly (not JSON.stringify)', async () => {
        mockExecuteRequest.mockResolvedValueOnce({ status: 200, body: 'plain text result', durationMs: 5 })
        const logged: unknown[] = []
        vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(args[0]) })
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const cmd = makeCmd('feature-flag-get-all', httpTool)
        await parse(cmd, ['feature-flag-get-all', '--why', 'test'])
        expect(logged.some(l => l === 'plain text result')).toBe(true)
    })
})

describe('runHandwritten – DIRECT_ENDPOINTS (query-run)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        tmpDir = mkdtempSync(join(tmpdir(), 'thehogcli-test-'))
        process.env.THEHOGCLI_HISTORY_DB = join(tmpDir, 'test.db')
        mockLoadConfig.mockReturnValue(fakeConfig)
    })
    afterEach(() => {
        delete process.env.THEHOGCLI_HISTORY_DB
        rmSync(tmpDir, { recursive: true, force: true })
        process.exitCode = 0
    })

    it('routes query-run to direct /query/ endpoint, not mcp_tools wrapper', async () => {
        const queryRunTool: RegistryTool = {
            module: 'insights-and-analytics',
            category: 'Insights & analytics',
            title: 'Run query',
            description: 'Run a HogQL or trends query',
            scopes: ['query:read'],
            annotations: {},
            http: null,
            inputs: { properties: { query: {} }, required: ['query'] },
        }
        mockFetch.mockResolvedValueOnce({
            status: 200,
            text: async () => JSON.stringify({ results: [[42]] }),
        })
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const cmd = makeCmd('query-run', queryRunTool)
        await parse(cmd, [
            'query-run', '--why', 'test',
            '--query', '{"kind":"HogQLQuery","query":"SELECT 1"}',
        ])
        expect(mockFetch).toHaveBeenCalledOnce()
        const [url, init] = mockFetch.mock.calls[0] as [string, { body: string }]
        expect(url).toContain('/api/projects/')
        expect(url).toContain('/query/')
        expect(url).not.toContain('mcp_tools')
        const body = JSON.parse(init.body)
        expect(body.query).toEqual({ kind: 'HogQLQuery', query: 'SELECT 1' })
    })

    it('unwraps ActorsQuery to its inner source transparently', async () => {
        const queryRunTool: RegistryTool = {
            module: 'insights-and-analytics', category: 'Insights & analytics',
            title: 'Run query', description: 'Run a query', scopes: ['query:read'],
            annotations: {}, http: null, inputs: { properties: { query: {} }, required: ['query'] },
        }
        mockFetch.mockResolvedValueOnce({
            status: 200,
            text: async () => JSON.stringify({ results: [['abc-person-id']] }),
        })
        const errLogs: string[] = []
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation((...a) => errLogs.push(String(a[0])))
        const cmd = makeCmd('query-run', queryRunTool)
        const actorsQuery = JSON.stringify({
            kind: 'ActorsQuery',
            source: { kind: 'HogQLQuery', query: 'SELECT DISTINCT person_id FROM events' },
        })
        await parse(cmd, ['query-run', '--why', 'test', '--query', actorsQuery])
        const [, init] = mockFetch.mock.calls[0] as [string, { body: string }]
        const sent = JSON.parse(init.body)
        // Inner HogQLQuery is sent, not the ActorsQuery wrapper
        expect(sent.query.kind).toBe('HogQLQuery')
        expect(sent.query).not.toHaveProperty('source')
        // User is informed about the unwrap
        expect(errLogs.some(l => l.includes('ActorsQuery'))).toBe(true)
    })

    it('unwraps PersonsQuery to its inner source transparently', async () => {
        const queryRunTool: RegistryTool = {
            module: 'insights-and-analytics', category: 'Insights & analytics',
            title: 'Run query', description: 'Run a query', scopes: ['query:read'],
            annotations: {}, http: null, inputs: { properties: { query: {} }, required: ['query'] },
        }
        mockFetch.mockResolvedValueOnce({
            status: 200,
            text: async () => JSON.stringify({ results: [] }),
        })
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const cmd = makeCmd('query-run', queryRunTool)
        const personsQuery = JSON.stringify({
            kind: 'PersonsQuery',
            source: { kind: 'HogQLQuery', query: 'SELECT person_id FROM events' },
        })
        await parse(cmd, ['query-run', '--why', 'test', '--query', personsQuery])
        const [, init] = mockFetch.mock.calls[0] as [string, { body: string }]
        const sent = JSON.parse(init.body)
        expect(sent.query.kind).toBe('HogQLQuery')
    })
})

describe('runHandwritten – 4xx response', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        tmpDir = mkdtempSync(join(tmpdir(), 'thehogcli-test-'))
        process.env.THEHOGCLI_HISTORY_DB = join(tmpDir, 'test.db')
        mockLoadConfig.mockReturnValue(fakeConfig)
    })
    afterEach(() => {
        delete process.env.THEHOGCLI_HISTORY_DB
        rmSync(tmpDir, { recursive: true, force: true })
        process.exitCode = 0
    })

    it('sets exitCode 1 and prints red badge on 4xx response', async () => {
        mockFetch.mockResolvedValueOnce({
            status: 403,
            text: async () => JSON.stringify({ detail: 'forbidden' }),
        })
        const errLogs: string[] = []
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation((...args) => { errLogs.push(String(args[0])) })
        const cmd = makeCmd('execute-sql', handwrittenTool)
        await parse(cmd, ['execute-sql', '--why', 'test', '--query', 'SELECT 1'])
        expect(process.exitCode).toBe(1)
        expect(errLogs.some(l => l.includes('403'))).toBe(true)
    })

    it('records empty preview when server responds with JSON null', async () => {
        mockFetch.mockResolvedValueOnce({
            status: 200,
            text: async () => 'null',
        })
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const cmd = makeCmd('execute-sql', handwrittenTool)
        await parse(cmd, ['execute-sql', '--why', 'test', '--query', 'SELECT 1'])
        expect(process.exitCode).toBeFalsy()
    })

    it('prints OAuth re-login hint when PostHog rejects Personal API Key', async () => {
        mockFetch.mockResolvedValueOnce({
            status: 403,
            text: async () => JSON.stringify({
                type: 'authentication_error',
                code: 'permission_denied',
                detail: 'This action does not support Personal API Key access',
            }),
        })
        const errLogs: string[] = []
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation((...args) => { errLogs.push(String(args[0])) })
        const cmd = makeCmd('execute-sql', handwrittenTool)
        await parse(cmd, ['execute-sql', '--why', 'test', '--query', 'SELECT 1'])
        expect(process.exitCode).toBe(1)
        expect(errLogs.some(l => l.includes('OAuth') || l.includes('thehogcli login'))).toBe(true)
    })
})

describe('printHandwrittenResult – non-content body', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        tmpDir = mkdtempSync(join(tmpdir(), 'thehogcli-test-'))
        process.env.THEHOGCLI_HISTORY_DB = join(tmpDir, 'test.db')
        mockLoadConfig.mockReturnValue(fakeConfig)
    })
    afterEach(() => {
        delete process.env.THEHOGCLI_HISTORY_DB
        rmSync(tmpDir, { recursive: true, force: true })
        process.exitCode = 0
    })

    it('JSON.stringify-s body object when no content property', async () => {
        mockFetch.mockResolvedValueOnce({
            status: 200,
            text: async () => JSON.stringify({ message: 'ok', data: 42 }),
        })
        const logged: unknown[] = []
        vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(args[0]) })
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const cmd = makeCmd('execute-sql', handwrittenTool)
        await parse(cmd, ['execute-sql', '--why', 'test', '--query', 'SELECT 1'])
        expect(logged.some(l => typeof l === 'string' && l.includes('"message"'))).toBe(true)
    })

    it('logs plain string body directly', async () => {
        mockFetch.mockResolvedValueOnce({
            status: 200,
            text: async () => 'just a plain string',
        })
        const logged: unknown[] = []
        vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(args[0]) })
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const cmd = makeCmd('execute-sql', handwrittenTool)
        await parse(cmd, ['execute-sql', '--why', 'test', '--query', 'SELECT 1'])
        expect(logged.some(l => l === 'just a plain string')).toBe(true)
    })
})

describe('runStandard – dry-run with POST body', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        tmpDir = mkdtempSync(join(tmpdir(), 'thehogcli-test-'))
        process.env.THEHOGCLI_HISTORY_DB = join(tmpDir, 'test.db')
        mockLoadConfig.mockReturnValue(fakeConfig)
        mockResolveRequest.mockReturnValue({
            method: 'POST',
            url: 'https://us.posthog.com/api/projects/12345/feature_flags/',
            headers: { Authorization: 'Bearer phx_test' },
            body: { name: 'my-flag', key: 'my-flag' },
        })
    })
    afterEach(() => {
        delete process.env.THEHOGCLI_HISTORY_DB
        rmSync(tmpDir, { recursive: true, force: true })
        process.exitCode = 0
    })

    it('prints body section when request has a body', async () => {
        const logged: string[] = []
        vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(String(args[0])) })
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const cmd = makeCmd('feature-flag-create', postTool)
        await parse(cmd, ['feature-flag-create', '--why', 'test', '--dry-run'])
        expect(logged.some(l => l.startsWith('body:'))).toBe(true)
    })
})

describe('parseValue – float and invalid JSON', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        tmpDir = mkdtempSync(join(tmpdir(), 'thehogcli-test-'))
        process.env.THEHOGCLI_HISTORY_DB = join(tmpDir, 'test.db')
        mockLoadConfig.mockReturnValue(fakeConfig)
        mockResolveRequest.mockReturnValue({
            method: 'POST',
            url: 'https://us.posthog.com/test',
            headers: {},
            body: null,
        })
    })
    afterEach(() => {
        delete process.env.THEHOGCLI_HISTORY_DB
        rmSync(tmpDir, { recursive: true, force: true })
        process.exitCode = 0
    })

    it('coerces float strings to numbers', async () => {
        const tool: RegistryTool = {
            ...httpTool,
            http: { method: 'POST', path: '/api/test/', pathParams: [], queryParams: ['ratio'], bodyParams: [] },
        }
        mockExecuteRequest.mockResolvedValueOnce({ status: 200, body: {}, durationMs: 5 })
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const cmd = makeCmd('set-ratio', tool)
        await parse(cmd, ['set-ratio', '--why', 'test', '--ratio', '3.14'])
        const params = (mockResolveRequest.mock.calls[0] as unknown[])[2] as Record<string, unknown>
        expect(params.ratio).toBe(3.14)
    })

    it('returns raw string when JSON.parse fails on {-prefixed input', async () => {
        const tool: RegistryTool = {
            ...httpTool,
            http: { method: 'POST', path: '/api/test/', pathParams: [], queryParams: [], bodyParams: ['filters'] },
        }
        mockExecuteRequest.mockResolvedValueOnce({ status: 200, body: {}, durationMs: 5 })
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const cmd = makeCmd('set-filters', tool)
        await parse(cmd, ['set-filters', '--why', 'test', '--filters', '{invalid json'])
        const params = (mockResolveRequest.mock.calls[0] as unknown[])[2] as Record<string, unknown>
        expect(params.filters).toBe('{invalid json')
    })
})

describe('runTool – autofill projectId from config', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        tmpDir = mkdtempSync(join(tmpdir(), 'thehogcli-test-'))
        process.env.THEHOGCLI_HISTORY_DB = join(tmpDir, 'test.db')
        mockLoadConfig.mockReturnValue({ ...fakeConfig, projectId: '999' })
    })
    afterEach(() => {
        delete process.env.THEHOGCLI_HISTORY_DB
        rmSync(tmpDir, { recursive: true, force: true })
        process.exitCode = 0
    })

    it('auto-fills projectId from cfg when tool schema declares projectId', async () => {
        const toolWithProjectId: RegistryTool = {
            ...handwrittenTool,
            inputs: {
                properties: {
                    projectId: { type: 'number', description: 'Project ID' },
                    query: { type: 'string', description: 'SQL query' },
                },
                required: ['query'],
            },
        }
        mockFetch.mockResolvedValueOnce({
            status: 200,
            text: async () => JSON.stringify({ success: true, content: 'ok' }),
        })
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const cmd = makeCmd('execute-sql', toolWithProjectId)
        await parse(cmd, ['execute-sql', '--why', 'test', '--query', 'SELECT 1'])
        expect(mockFetch).toHaveBeenCalledOnce()
        const [, init] = mockFetch.mock.calls[0] as [string, { body: string }]
        const body = JSON.parse(init.body)
        expect(body.args.projectId).toBe('999')
    })
})

describe('parseArgs – non-object JSON', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        tmpDir = mkdtempSync(join(tmpdir(), 'thehogcli-test-'))
        process.env.THEHOGCLI_HISTORY_DB = join(tmpDir, 'test.db')
        mockLoadConfig.mockReturnValue(fakeConfig)
    })
    afterEach(() => {
        delete process.env.THEHOGCLI_HISTORY_DB
        rmSync(tmpDir, { recursive: true, force: true })
        process.exitCode = 0
    })

    it('sets exitCode 1 when --args is a JSON array (not an object)', async () => {
        const errLogs: string[] = []
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation((...args) => { errLogs.push(String(args[0])) })
        const cmd = makeCmd('execute-sql', handwrittenTool)
        await parse(cmd, ['execute-sql', '--why', 'test', '--query', 'SELECT 1', '--args', '[1,2,3]'])
        expect(process.exitCode).toBe(1)
        expect(errLogs.some(l => l.includes('failed to parse'))).toBe(true)
    })

    it('returns empty params when --args is whitespace-only', async () => {
        mockFetch.mockResolvedValueOnce({
            status: 200,
            text: async () => JSON.stringify({ success: true, content: 'ok' }),
        })
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const cmd = makeCmd('execute-sql', handwrittenTool)
        await parse(cmd, ['execute-sql', '--why', 'test', '--query', 'SELECT 1', '--args', '   '])
        expect(mockFetch).toHaveBeenCalledOnce()
        const [, init] = mockFetch.mock.calls[0] as [string, { body: string }]
        const body = JSON.parse(init.body)
        expect(body.args.query).toBe('SELECT 1')
    })
})

describe('typeLabel – enum and array type', () => {
    it('renders "one of: ..." for enum props', () => {
        const program = new Command()
        const tool: RegistryTool = {
            ...handwrittenTool,
            inputs: { properties: { color: { enum: ['red', 'green', 'blue'] } } },
        }
        const cmd = registerToolCommand(program, { toolName: 'color-tool', tool })
        const colorOpt = cmd.options.find((o) => o.long === '--color')
        expect(colorOpt?.description).toContain('one of: red, green, blue')
    })

    it('renders a JSON hint for props with no type or enum', () => {
        const program = new Command()
        const tool: RegistryTool = {
            ...handwrittenTool,
            inputs: { properties: { mystery: {} } },
        }
        const cmd = registerToolCommand(program, { toolName: 'mystery-tool', tool })
        const opt = cmd.options.find((o) => o.long === '--mystery')
        expect(opt?.description).toContain('JSON')
    })

    it('renders array type joined with |', () => {
        const program = new Command()
        const tool: RegistryTool = {
            ...handwrittenTool,
            inputs: { properties: { mode: { type: ['string', 'null'] } } },
        }
        const cmd = registerToolCommand(program, { toolName: 'mode-tool', tool })
        const opt = cmd.options.find((o) => o.long === '--mode')
        expect(opt?.description).toContain('string|null')
    })

    it('marks required props', () => {
        const program = new Command()
        const tool: RegistryTool = {
            ...handwrittenTool,
            inputs: { properties: { query: { type: 'string' } }, required: ['query'] },
        }
        const cmd = registerToolCommand(program, { toolName: 'req-tool', tool })
        const opt = cmd.options.find((o) => o.long === '--query')
        expect(opt?.description).toContain('(required)')
    })
})

describe('parseValue coercions', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        tmpDir = mkdtempSync(join(tmpdir(), 'thehogcli-test-'))
        process.env.THEHOGCLI_HISTORY_DB = join(tmpDir, 'test.db')
        mockLoadConfig.mockReturnValue(fakeConfig)
        mockResolveRequest.mockReturnValue({
            method: 'POST',
            url: 'https://us.posthog.com/test',
            headers: {},
            body: null,
        })
    })
    afterEach(() => {
        delete process.env.THEHOGCLI_HISTORY_DB
        rmSync(tmpDir, { recursive: true, force: true })
        process.exitCode = 0
    })

    it('coerces "true" string to boolean true', async () => {
        const tool: RegistryTool = {
            ...httpTool,
            http: { method: 'POST', path: '/api/projects/{project_id}/flags/', pathParams: [], queryParams: [], bodyParams: ['active'] },
        }
        mockExecuteRequest.mockResolvedValueOnce({ status: 200, body: {}, durationMs: 5 })
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const cmd = makeCmd('flag-create', tool)
        await parse(cmd, ['flag-create', '--why', 'test', '--active', 'true'])
        const params = (mockResolveRequest.mock.calls[0] as unknown[])[2] as Record<string, unknown>
        expect(params.active).toBe(true)
    })

    it('coerces "false" string to boolean false', async () => {
        const tool: RegistryTool = {
            ...httpTool,
            http: { method: 'POST', path: '/api/projects/{project_id}/flags/', pathParams: [], queryParams: [], bodyParams: ['active'] },
        }
        mockExecuteRequest.mockResolvedValueOnce({ status: 200, body: {}, durationMs: 5 })
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const cmd = makeCmd('flag-create', tool)
        await parse(cmd, ['flag-create', '--why', 'test', '--active', 'false'])
        const params = (mockResolveRequest.mock.calls[0] as unknown[])[2] as Record<string, unknown>
        expect(params.active).toBe(false)
    })

    it('coerces integer strings to numbers', async () => {
        const tool: RegistryTool = {
            ...httpTool,
            http: { method: 'POST', path: '/api/test/', pathParams: [], queryParams: [], bodyParams: ['count'] },
        }
        mockExecuteRequest.mockResolvedValueOnce({ status: 200, body: {}, durationMs: 5 })
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const cmd = makeCmd('set-count', tool)
        await parse(cmd, ['set-count', '--why', 'test', '--count', '42'])
        const params = (mockResolveRequest.mock.calls[0] as unknown[])[2] as Record<string, unknown>
        expect(params.count).toBe(42)
    })

    it('parses JSON object strings', async () => {
        const tool: RegistryTool = {
            ...httpTool,
            http: { method: 'POST', path: '/api/test/', pathParams: [], queryParams: [], bodyParams: ['filters'] },
        }
        mockExecuteRequest.mockResolvedValueOnce({ status: 200, body: {}, durationMs: 5 })
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const cmd = makeCmd('set-filters', tool)
        await parse(cmd, ['set-filters', '--why', 'test', '--filters', '{"key":"val"}'])
        const params = (mockResolveRequest.mock.calls[0] as unknown[])[2] as Record<string, unknown>
        expect(params.filters).toEqual({ key: 'val' })
    })
})
