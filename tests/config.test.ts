import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>()
    return {
        ...actual,
        existsSync: vi.fn(),
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
        chmodSync: vi.fn(),
    }
})

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { loadConfig, saveConfig, configPath } from '../src/lib/config.js'

const mockExistsSync = existsSync as ReturnType<typeof vi.fn>
const mockReadFileSync = readFileSync as ReturnType<typeof vi.fn>
const mockWriteFileSync = writeFileSync as ReturnType<typeof vi.fn>
const mockMkdirSync = mkdirSync as ReturnType<typeof vi.fn>
const mockChmodSync = chmodSync as ReturnType<typeof vi.fn>

function clearEnv(): void {
    delete process.env.POSTHOG_CLI_API_KEY
    delete process.env.POSTHOG_CLI_HOST
    delete process.env.POSTHOG_CLI_PROJECT_ID
    delete process.env.POSTHOG_CLI_ORG_ID
}

describe('loadConfig', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        clearEnv()
        mockExistsSync.mockReturnValue(false)
    })

    afterEach(() => {
        clearEnv()
    })

    it('returns defaults when no env vars and no file', () => {
        const cfg = loadConfig()
        expect(cfg.host).toBe('https://us.posthog.com')
        expect(cfg.apiKey).toBeNull()
        expect(cfg.projectId).toBeNull()
        expect(cfg.orgId).toBeNull()
        expect(cfg.refreshToken).toBeNull()
        expect(cfg.clientId).toBeNull()
        expect(cfg.expiresAt).toBeNull()
    })

    it('reads POSTHOG_CLI_API_KEY env var', () => {
        process.env.POSTHOG_CLI_API_KEY = 'phx_testkey123'
        const cfg = loadConfig()
        expect(cfg.apiKey).toBe('phx_testkey123')
    })

    it('treats empty POSTHOG_CLI_API_KEY as absent', () => {
        process.env.POSTHOG_CLI_API_KEY = ''
        const cfg = loadConfig()
        expect(cfg.apiKey).toBeNull()
    })

    it('reads POSTHOG_CLI_HOST env var', () => {
        process.env.POSTHOG_CLI_HOST = 'https://eu.posthog.com'
        const cfg = loadConfig()
        expect(cfg.host).toBe('https://eu.posthog.com')
    })

    it('treats empty POSTHOG_CLI_HOST as absent, uses default', () => {
        process.env.POSTHOG_CLI_HOST = ''
        const cfg = loadConfig()
        expect(cfg.host).toBe('https://us.posthog.com')
    })

    it('reads POSTHOG_CLI_PROJECT_ID env var', () => {
        process.env.POSTHOG_CLI_PROJECT_ID = '12345'
        const cfg = loadConfig()
        expect(cfg.projectId).toBe('12345')
    })

    it('treats empty POSTHOG_CLI_PROJECT_ID as absent', () => {
        process.env.POSTHOG_CLI_PROJECT_ID = ''
        const cfg = loadConfig()
        expect(cfg.projectId).toBeNull()
    })

    it('reads POSTHOG_CLI_ORG_ID env var', () => {
        process.env.POSTHOG_CLI_ORG_ID = 'org-abc'
        const cfg = loadConfig()
        expect(cfg.orgId).toBe('org-abc')
    })

    it('reads config from file when env vars absent', () => {
        mockExistsSync.mockReturnValue(true)
        mockReadFileSync.mockReturnValue(
            JSON.stringify({
                api_key: 'phx_fromfile',
                host: 'https://custom.posthog.com',
                project_id: 99,
                org_id: 'org-file',
                refresh_token: 'rtoken',
                client_id: 'cid',
                expires_at: 9999999,
            })
        )
        const cfg = loadConfig()
        expect(cfg.apiKey).toBe('phx_fromfile')
        expect(cfg.host).toBe('https://custom.posthog.com')
        expect(cfg.projectId).toBe('99')
        expect(cfg.orgId).toBe('org-file')
        expect(cfg.refreshToken).toBe('rtoken')
        expect(cfg.clientId).toBe('cid')
        expect(cfg.expiresAt).toBe(9999999)
    })

    it('env var wins over file value', () => {
        process.env.POSTHOG_CLI_API_KEY = 'phx_env'
        mockExistsSync.mockReturnValue(true)
        mockReadFileSync.mockReturnValue(JSON.stringify({ api_key: 'phx_file' }))
        const cfg = loadConfig()
        expect(cfg.apiKey).toBe('phx_env')
    })

    it('returns {} gracefully when file has invalid JSON', () => {
        mockExistsSync.mockReturnValue(true)
        mockReadFileSync.mockReturnValue('not valid json {{{')
        const cfg = loadConfig()
        expect(cfg.apiKey).toBeNull()
        expect(cfg.host).toBe('https://us.posthog.com')
    })
})

describe('saveConfig', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockExistsSync.mockReturnValue(false)
    })

    it('writes merged config to USER_CONFIG_PATH with mode 0600', () => {
        const path = saveConfig({ api_key: 'phx_new', host: 'https://us.posthog.com' })
        expect(mockMkdirSync).toHaveBeenCalledOnce()
        expect(mockWriteFileSync).toHaveBeenCalledOnce()
        const [writtenPath, writtenData, writtenOpts] = mockWriteFileSync.mock.calls[0]
        expect(writtenPath).toBe(path)
        expect(writtenOpts).toMatchObject({ mode: 0o600 })
        const parsed = JSON.parse(writtenData as string) as Record<string, unknown>
        expect(parsed.api_key).toBe('phx_new')
        expect(parsed.host).toBe('https://us.posthog.com')
        expect(mockChmodSync).toHaveBeenCalledWith(path, 0o600)
    })

    it('merges with existing file content', () => {
        mockExistsSync.mockReturnValue(true)
        mockReadFileSync.mockReturnValue(JSON.stringify({ api_key: 'old', project_id: '123' }))
        saveConfig({ api_key: 'new' })
        const writtenData = mockWriteFileSync.mock.calls[0][1] as string
        const parsed = JSON.parse(writtenData) as Record<string, unknown>
        expect(parsed.api_key).toBe('new')
        expect(parsed.project_id).toBe('123')
    })

    it('returns the config file path', () => {
        const path = saveConfig({})
        expect(typeof path).toBe('string')
        expect(path).toContain('.thehogcli')
        expect(path).toContain('config.json')
    })
})

describe('configPath', () => {
    it('returns a path ending in config.json inside .thehogcli', () => {
        const p = configPath()
        expect(p).toContain('.thehogcli')
        expect(p.endsWith('config.json')).toBe(true)
    })
})
