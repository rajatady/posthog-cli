import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'

vi.mock('../src/lib/config.js', () => ({
    loadConfig: vi.fn(),
    saveConfig: vi.fn().mockReturnValue('/tmp/.thehogcli/config.json'),
    configPath: vi.fn().mockReturnValue('/tmp/.thehogcli/config.json'),
}))
vi.mock('../src/lib/discover.js', () => ({
    autoDiscover: vi.fn(),
    listProjects: vi.fn(),
}))
vi.mock('../src/lib/oauth.js', () => ({
    registerClient: vi.fn(),
    authorize: vi.fn(),
    refreshToken: vi.fn(),
    pkcePair: vi.fn(),
}))
vi.mock('../src/lib/auth.js', () => ({
    ask: vi.fn(),
    askSecret: vi.fn(),
    readableConfigSnapshot: vi.fn().mockReturnValue('host: https://us.posthog.com\nproject_id: 12345\napi_key: phx_abcd…  expires in 59 min\nclient_id: cid'),
}))

import { loadConfig, saveConfig } from '../src/lib/config.js'
import { autoDiscover, listProjects } from '../src/lib/discover.js'
import { registerClient, authorize } from '../src/lib/oauth.js'
import { ask, askSecret, readableConfigSnapshot } from '../src/lib/auth.js'
import { registerLoginCommand } from '../src/commands/login.js'

const mockLoadConfig = loadConfig as ReturnType<typeof vi.fn>
const mockSaveConfig = saveConfig as ReturnType<typeof vi.fn>
const mockListProjects = listProjects as ReturnType<typeof vi.fn>
const mockReadableSnapshot = readableConfigSnapshot as ReturnType<typeof vi.fn>
const mockAutoDiscover = autoDiscover as ReturnType<typeof vi.fn>
const mockRegisterClient = registerClient as ReturnType<typeof vi.fn>
const mockAuthorize = authorize as ReturnType<typeof vi.fn>
const mockAsk = ask as ReturnType<typeof vi.fn>
const mockAskSecret = askSecret as ReturnType<typeof vi.fn>

const fakeConfig = {
    host: 'https://us.posthog.com',
    apiKey: 'phx_test',
    refreshToken: null,
    clientId: 'cid',
    expiresAt: Date.now() + 3600 * 1000,
    projectId: '12345',
    orgId: null,
}

function makeProgram(): Command {
    const p = new Command().name('thehogcli').exitOverride()
    registerLoginCommand(p)
    return p
}

async function parse(program: Command, args: string[]): Promise<void> {
    await program.parseAsync(args, { from: 'user' })
}

let tmpDir: string

beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = mkdtempSync(join(tmpdir(), 'thehogcli-login-test-'))
    mockLoadConfig.mockReturnValue(fakeConfig)
})

afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    process.exitCode = 0
    vi.restoreAllMocks()
})

describe('whoami', () => {
    it('prints config snapshot and config path', async () => {
        const program = makeProgram()
        const logged: string[] = []
        vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(String(args[0])) })
        vi.spyOn(console, 'error').mockImplementation(() => {})
        await parse(program, ['whoami'])
        expect(mockReadableSnapshot).toHaveBeenCalledOnce()
        expect(logged.some(l => l.includes('https://us.posthog.com'))).toBe(true)
    })

    it('sets exitCode 1 and warns when no API key', async () => {
        mockLoadConfig.mockReturnValue({ ...fakeConfig, apiKey: null })
        const errLogs: string[] = []
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation((...args) => { errLogs.push(String(args[0])) })
        await parse(makeProgram(), ['whoami'])
        expect(process.exitCode).toBe(1)
        expect(errLogs.some(l => l.includes('No API key'))).toBe(true)
    })
})

describe('projects', () => {
    it('lists projects with active marker', async () => {
        mockListProjects.mockResolvedValueOnce([
            { id: '12345', name: 'Prod', organizationId: 'org-1' },
            { id: '99999', name: 'Staging', organizationId: 'org-1' },
        ])
        const logged: string[] = []
        vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(String(args[0])) })
        vi.spyOn(console, 'error').mockImplementation(() => {})
        await parse(makeProgram(), ['projects'])
        expect(logged.some(l => l.includes('Prod'))).toBe(true)
        expect(logged.some(l => l.includes('Staging'))).toBe(true)
    })

    it('sets exitCode 1 when no API key', async () => {
        mockLoadConfig.mockReturnValue({ ...fakeConfig, apiKey: null })
        const errLogs: string[] = []
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation((...args) => { errLogs.push(String(args[0])) })
        await parse(makeProgram(), ['projects'])
        expect(process.exitCode).toBe(1)
        expect(errLogs.some(l => l.includes('No API key'))).toBe(true)
    })

    it('sets exitCode 1 when project list is empty', async () => {
        mockListProjects.mockResolvedValueOnce([])
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})
        await parse(makeProgram(), ['projects'])
        expect(process.exitCode).toBe(1)
    })

    it('shows @current when projectId is null', async () => {
        mockLoadConfig.mockReturnValue({ ...fakeConfig, projectId: null })
        mockListProjects.mockResolvedValueOnce([
            { id: '1', name: 'Only Project', organizationId: 'org-1' },
        ])
        const logged: string[] = []
        vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(String(args[0])) })
        vi.spyOn(console, 'error').mockImplementation(() => {})
        await parse(makeProgram(), ['projects'])
        expect(logged.some(l => l.includes('@current'))).toBe(true)
    })
})

describe('use', () => {
    it('saves project_id and prints success', async () => {
        const logged: string[] = []
        vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(String(args[0])) })
        vi.spyOn(console, 'error').mockImplementation(() => {})
        await parse(makeProgram(), ['use', '99999'])
        expect(mockSaveConfig).toHaveBeenCalledWith({ project_id: '99999' })
        expect(logged.some(l => l.includes('99999'))).toBe(true)
    })

    it('sets exitCode 1 when projectId is not numeric', async () => {
        const errLogs: string[] = []
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation((...args) => { errLogs.push(String(args[0])) })
        await parse(makeProgram(), ['use', 'not-a-number'])
        expect(process.exitCode).toBe(1)
        expect(errLogs.some(l => l.includes('must be numeric'))).toBe(true)
    })
})

describe('scopes', () => {
    it('prints scope list derived from registry', async () => {
        const logged: string[] = []
        vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(String(args[0])) })
        vi.spyOn(console, 'error').mockImplementation(() => {})
        await parse(makeProgram(), ['scopes'])
        expect(logged.some(l => l.includes('scopes'))).toBe(true)
        expect(logged.some(l => l.includes(':read') || l.includes(':write'))).toBe(true)
    })

    it('prints only read scopes with --read-only', async () => {
        const logged: string[] = []
        vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(String(args[0])) })
        vi.spyOn(console, 'error').mockImplementation(() => {})
        await parse(makeProgram(), ['scopes', '--read-only'])
        const scopeLines = logged.filter(l => l.trim().endsWith(':read') || l.trim().endsWith(':write'))
        expect(scopeLines.every(l => l.includes(':read'))).toBe(true)
    })
})

describe('login – non-TTY guard', () => {
    it('exits 1 with error when stdout is not a TTY', async () => {
        const originalIsTTY = process.stdout.isTTY
        Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
        try {
            const errLogs: string[] = []
            vi.spyOn(console, 'error').mockImplementation((...args) => { errLogs.push(String(args[0])) })
            await parse(makeProgram(), ['login'])
            expect(process.exitCode).toBe(1)
            expect(errLogs.some(l => l.includes('needs a terminal'))).toBe(true)
        } finally {
            Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true })
        }
    })
})

describe('login – OAuth flow (oauthLogin)', () => {
    let originalIsTTY: boolean

    beforeEach(() => {
        originalIsTTY = process.stdout.isTTY
        Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})

        mockRegisterClient.mockResolvedValue({ clientId: 'new-client-id' })
        mockAuthorize.mockResolvedValue({
            accessToken: 'access-tok',
            refreshToken: 'refresh-tok',
            expiresAt: Date.now() + 3600_000,
            scope: 'feature_flag:read',
        })
        mockAutoDiscover.mockResolvedValue({
            projectId: '99',
            orgId: 'org-1',
            ambiguous: false,
            activeTeamName: 'My Team',
            activeOrgName: 'My Org',
        })
        mockSaveConfig.mockReturnValue('/path/to/config.json')
    })

    afterEach(() => {
        Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true })
    })

    it('registers new client and saves tokens when no existing clientId', async () => {
        mockLoadConfig.mockReturnValue({ ...fakeConfig, clientId: null })
        // Make authorize invoke the onRedirectURL callback so that code path is covered
        mockAuthorize.mockImplementation(async (opts: { onRedirectURL?: (url: string) => void }) => {
            opts.onRedirectURL?.('https://us.posthog.com/oauth/authorize?code=123')
            return { accessToken: 'access-tok', refreshToken: 'refresh-tok', expiresAt: Date.now() + 3600_000, scope: 'feature_flag:read' }
        })
        await parse(makeProgram(), ['login', '--host', 'https://us.posthog.com'])
        expect(mockRegisterClient).toHaveBeenCalledWith('https://us.posthog.com')
        expect(mockAuthorize).toHaveBeenCalled()
        expect(mockSaveConfig).toHaveBeenCalledWith(
            expect.objectContaining({ api_key: 'access-tok', project_id: '99' })
        )
    })

    it('reuses existing client_id when host matches', async () => {
        mockLoadConfig.mockReturnValue({ ...fakeConfig, host: 'https://us.posthog.com', clientId: 'existing-cid' })
        await parse(makeProgram(), ['login', '--host', 'https://us.posthog.com'])
        expect(mockRegisterClient).not.toHaveBeenCalled()
        expect(mockAuthorize).toHaveBeenCalled()
    })

    it('registers new client when host differs from existing', async () => {
        mockLoadConfig.mockReturnValue({ ...fakeConfig, host: 'https://eu.posthog.com', clientId: 'eu-cid' })
        await parse(makeProgram(), ['login', '--host', 'https://us.posthog.com'])
        expect(mockRegisterClient).toHaveBeenCalledWith('https://us.posthog.com')
    })

    it('shows ambiguous project message without setting exitCode 1', async () => {
        mockLoadConfig.mockReturnValue({ ...fakeConfig, clientId: 'cid' })
        mockAutoDiscover.mockResolvedValue({
            projectId: null, orgId: null, ambiguous: true,
            activeTeamName: null, activeOrgName: null,
        })
        await parse(makeProgram(), ['login', '--host', 'https://us.posthog.com'])
        expect(process.exitCode).toBe(0)
    })

    it('shows @current alias message when no project and not ambiguous', async () => {
        mockLoadConfig.mockReturnValue({ ...fakeConfig, clientId: 'cid' })
        mockAutoDiscover.mockResolvedValue({
            projectId: null, orgId: null, ambiguous: false,
            activeTeamName: null, activeOrgName: null,
        })
        const logged: string[] = []
        vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(String(args[0])) })
        await parse(makeProgram(), ['login', '--host', 'https://us.posthog.com'])
        expect(logged.some(l => l.includes('@current'))).toBe(true)
    })

    it('saves orgId when autoDiscover returns one', async () => {
        mockLoadConfig.mockReturnValue({ ...fakeConfig, clientId: 'cid' })
        mockAutoDiscover.mockResolvedValue({
            projectId: '55', orgId: 'org-xyz', ambiguous: false,
            activeTeamName: null, activeOrgName: 'Some Org',
        })
        await parse(makeProgram(), ['login', '--host', 'https://us.posthog.com'])
        expect(mockSaveConfig).toHaveBeenCalledWith(
            expect.objectContaining({ org_id: 'org-xyz' })
        )
    })

    it('shows org without name when activeOrgName is null', async () => {
        mockLoadConfig.mockReturnValue({ ...fakeConfig, clientId: 'cid' })
        mockAutoDiscover.mockResolvedValue({
            projectId: '55', orgId: 'org-no-name', ambiguous: false,
            activeTeamName: null, activeOrgName: null,
        })
        const logged: string[] = []
        vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(String(args[0])) })
        await parse(makeProgram(), ['login', '--host', 'https://us.posthog.com'])
        expect(logged.some(l => l.includes('org-no-name'))).toBe(true)
        // activeOrgName is null → no parenthetical name suffix
        expect(logged.some(l => l.includes('org-no-name ('))).toBe(false)
    })

    it('shows "N requested" when tokens.scope is undefined', async () => {
        mockLoadConfig.mockReturnValue({ ...fakeConfig, clientId: 'cid' })
        mockAuthorize.mockResolvedValue({
            accessToken: 'tok', refreshToken: null, expiresAt: null, scope: undefined,
        })
        const logged: string[] = []
        vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(String(args[0])) })
        await parse(makeProgram(), ['login', '--host', 'https://us.posthog.com'])
        expect(logged.some(l => l.includes('requested'))).toBe(true)
    })

    it('sets exitCode 1 and prints error on OAuth failure', async () => {
        mockLoadConfig.mockReturnValue({ ...fakeConfig, clientId: null })
        mockRegisterClient.mockRejectedValue(new Error('network error'))
        const errLogs: string[] = []
        vi.spyOn(console, 'error').mockImplementation((...args) => { errLogs.push(String(args[0])) })
        await parse(makeProgram(), ['login', '--host', 'https://us.posthog.com'])
        expect(process.exitCode).toBe(1)
        expect(errLogs.some(l => l.includes('network error'))).toBe(true)
    })
})

describe('login – selectHost via ask', () => {
    let originalIsTTY: boolean

    beforeEach(() => {
        originalIsTTY = process.stdout.isTTY
        Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})

        mockLoadConfig.mockReturnValue({ ...fakeConfig, clientId: null })
        mockRegisterClient.mockResolvedValue({ clientId: 'cid' })
        mockAuthorize.mockResolvedValue({
            accessToken: 'tok', refreshToken: null, expiresAt: null, scope: 'f:read',
        })
        mockAutoDiscover.mockResolvedValue({
            projectId: null, orgId: null, ambiguous: false,
            activeTeamName: null, activeOrgName: null,
        })
        mockSaveConfig.mockReturnValue('/tmp/cfg')
    })

    afterEach(() => {
        Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true })
    })

    it('selects US host for choice 1', async () => {
        mockAsk.mockResolvedValueOnce('1')
        await parse(makeProgram(), ['login'])
        expect(mockRegisterClient).toHaveBeenCalledWith('https://us.posthog.com')
    })

    it('selects EU host for choice 2', async () => {
        mockAsk.mockResolvedValueOnce('2')
        await parse(makeProgram(), ['login'])
        expect(mockRegisterClient).toHaveBeenCalledWith('https://eu.posthog.com')
    })

    it('prompts for custom URL when choice is not 1 or 2', async () => {
        mockAsk
            .mockResolvedValueOnce('3')
            .mockResolvedValueOnce('https://my.posthog.com')
        await parse(makeProgram(), ['login'])
        expect(mockRegisterClient).toHaveBeenCalledWith('https://my.posthog.com')
    })

    it('trims trailing slash from custom URL', async () => {
        mockAsk
            .mockResolvedValueOnce('3')
            .mockResolvedValueOnce('https://my.posthog.com/')
        await parse(makeProgram(), ['login'])
        expect(mockRegisterClient).toHaveBeenCalledWith('https://my.posthog.com')
    })

    it('sets exitCode 1 when custom URL is not a valid http(s) URL', async () => {
        mockAsk
            .mockResolvedValueOnce('3')
            .mockResolvedValueOnce('not-a-url')
        const errLogs: string[] = []
        vi.spyOn(console, 'error').mockImplementation((...args) => { errLogs.push(String(args[0])) })
        await parse(makeProgram(), ['login'])
        expect(process.exitCode).toBe(1)
        expect(errLogs.some(l => l.includes('Host must be a full URL'))).toBe(true)
    })
})

describe('login --manual', () => {
    let originalIsTTY: boolean

    beforeEach(() => {
        originalIsTTY = process.stdout.isTTY
        Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})
        mockSaveConfig.mockReturnValue('/tmp/cfg')
    })

    afterEach(() => {
        Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true })
    })

    it('saves PAT and project id on success', async () => {
        mockAskSecret.mockResolvedValue('phx_my_key')
        mockAsk.mockResolvedValue('12345')
        const logged: string[] = []
        vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(String(args[0])) })
        await parse(makeProgram(), ['login', '--host', 'https://us.posthog.com', '--manual'])
        expect(mockSaveConfig).toHaveBeenCalledWith(
            expect.objectContaining({ api_key: 'phx_my_key', project_id: '12345' })
        )
        expect(logged.some(l => l.includes('Saved'))).toBe(true)
    })

    it('sets exitCode 1 when API key is empty', async () => {
        mockAskSecret.mockResolvedValue('')
        const errLogs: string[] = []
        vi.spyOn(console, 'error').mockImplementation((...args) => { errLogs.push(String(args[0])) })
        await parse(makeProgram(), ['login', '--host', 'https://us.posthog.com', '--manual'])
        expect(process.exitCode).toBe(1)
        expect(errLogs.some(l => l.includes('No API key'))).toBe(true)
    })

    it('sets exitCode 1 when project id is empty', async () => {
        mockAskSecret.mockResolvedValue('phx_key')
        mockAsk.mockResolvedValue('')
        const errLogs: string[] = []
        vi.spyOn(console, 'error').mockImplementation((...args) => { errLogs.push(String(args[0])) })
        await parse(makeProgram(), ['login', '--host', 'https://us.posthog.com', '--manual'])
        expect(process.exitCode).toBe(1)
        expect(errLogs.some(l => l.includes('No project id'))).toBe(true)
    })
})

describe('login – resolveScopes', () => {
    let originalIsTTY: boolean

    beforeEach(() => {
        originalIsTTY = process.stdout.isTTY
        Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})

        mockLoadConfig.mockReturnValue({ ...fakeConfig, clientId: null })
        mockRegisterClient.mockResolvedValue({ clientId: 'cid' })
        mockAuthorize.mockResolvedValue({
            accessToken: 'tok', refreshToken: null, expiresAt: null, scope: 'custom:read',
        })
        mockAutoDiscover.mockResolvedValue({
            projectId: null, orgId: null, ambiguous: false,
            activeTeamName: null, activeOrgName: null,
        })
        mockSaveConfig.mockReturnValue('/tmp/cfg')
    })

    afterEach(() => {
        Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true })
    })

    it('uses explicit comma-separated scopes from --scopes flag', async () => {
        await parse(makeProgram(), [
            'login', '--host', 'https://us.posthog.com',
            '--scopes', 'feature_flag:read,dashboard:read',
        ])
        const call = mockAuthorize.mock.calls[0][0] as { scopes: string[] }
        expect(call.scopes).toEqual(['feature_flag:read', 'dashboard:read'])
    })

    it('uses only :read scopes with --read-only', async () => {
        await parse(makeProgram(), [
            'login', '--host', 'https://us.posthog.com', '--read-only',
        ])
        const call = mockAuthorize.mock.calls[0][0] as { scopes: string[] }
        expect(call.scopes.every((s: string) => s.endsWith(':read'))).toBe(true)
        expect(call.scopes.length).toBeGreaterThan(0)
    })

    it('uses full scope set when no flags', async () => {
        await parse(makeProgram(), ['login', '--host', 'https://us.posthog.com'])
        const call = mockAuthorize.mock.calls[0][0] as { scopes: string[] }
        expect(call.scopes.some((s: string) => s.endsWith(':write'))).toBe(true)
    })
})
