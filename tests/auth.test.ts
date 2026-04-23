import { EventEmitter } from 'node:events'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readableConfigSnapshot } from '../src/lib/auth.js'
import type { Config } from '../src/lib/config.js'

// ask() wraps readline/promises which requires a real TTY — test it by mocking the interface
vi.mock('node:readline/promises', () => ({
    createInterface: vi.fn().mockReturnValue({
        question: vi.fn().mockResolvedValue('test-answer'),
        close: vi.fn(),
    }),
}))

import { createInterface } from 'node:readline/promises'
import { ask, askSecret } from '../src/lib/auth.js'

const mockCreateInterface = createInterface as ReturnType<typeof vi.fn>

describe('readableConfigSnapshot', () => {
    const base: Config = {
        host: 'https://us.posthog.com',
        apiKey: null,
        refreshToken: null,
        clientId: null,
        expiresAt: null,
        projectId: null,
        orgId: null,
    }

    it('shows (none) when no apiKey', () => {
        const out = readableConfigSnapshot(base)
        expect(out).toContain('api_key:    (none)')
    })

    it('truncates apiKey to first 8 chars with ellipsis', () => {
        const cfg: Config = { ...base, apiKey: 'phx_abcdefghijk' }
        const out = readableConfigSnapshot(cfg)
        expect(out).toContain('phx_abcd…')
    })

    it('shows expiry when expiresAt is in the future', () => {
        const cfg: Config = { ...base, expiresAt: Date.now() + 30 * 60 * 1000 }
        const out = readableConfigSnapshot(cfg)
        expect(out).toContain('expires in')
    })

    it('shows expired when expiresAt is in the past', () => {
        const cfg: Config = { ...base, expiresAt: Date.now() - 1000 }
        const out = readableConfigSnapshot(cfg)
        expect(out).toContain('expired (will auto-refresh)')
    })

    it('shows (no expiry) for PAT tokens (expiresAt null)', () => {
        const out = readableConfigSnapshot(base)
        expect(out).toContain('(no expiry — PAT or manual)')
    })

    it('shows host, project_id, client_id', () => {
        const cfg: Config = {
            ...base,
            projectId: '12345',
            clientId: 'myclient',
        }
        const out = readableConfigSnapshot(cfg)
        expect(out).toContain('host:       https://us.posthog.com')
        expect(out).toContain('project_id: 12345')
        expect(out).toContain('client_id:  myclient')
    })

    it('shows (none) placeholders for unset optional fields', () => {
        const out = readableConfigSnapshot(base)
        expect(out).toContain('project_id: (none)')
        expect(out).toContain('client_id:  (none — no OAuth registration yet)')
    })
})

describe('askSecret', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fakeStdin: any
    let originalStdin: typeof process.stdin

    beforeEach(() => {
        originalStdin = process.stdin
        fakeStdin = new EventEmitter()
        fakeStdin.isTTY = false
        fakeStdin.isRaw = false
        fakeStdin.setRawMode = vi.fn()
        fakeStdin.resume = vi.fn()
        fakeStdin.pause = vi.fn()
        fakeStdin.setEncoding = vi.fn()
        Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true })
        vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    })

    afterEach(() => {
        Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true })
        vi.restoreAllMocks()
    })

    it('resolves with typed text on newline', async () => {
        const p = askSecret('Password: ')
        fakeStdin.emit('data', 'hello')
        fakeStdin.emit('data', '\n')
        await expect(p).resolves.toBe('hello')
    })

    it('resolves with typed text on carriage return', async () => {
        const p = askSecret('Secret: ')
        fakeStdin.emit('data', 'world')
        fakeStdin.emit('data', '\r')
        await expect(p).resolves.toBe('world')
    })

    it('handles backspace removing last character', async () => {
        const p = askSecret('Password: ')
        fakeStdin.emit('data', 'abc')
        fakeStdin.emit('data', '\b')
        fakeStdin.emit('data', '\n')
        await expect(p).resolves.toBe('ab')
    })

    it('does not call setRawMode when stdin is not a TTY', async () => {
        const p = askSecret('Password: ')
        fakeStdin.emit('data', '\n')
        await p
        expect(fakeStdin.setRawMode).not.toHaveBeenCalled()
    })

    it('calls setRawMode(true) when stdin is a TTY', async () => {
        fakeStdin.isTTY = true
        const p = askSecret('Password: ')
        fakeStdin.emit('data', '\n')
        await p
        expect(fakeStdin.setRawMode).toHaveBeenCalledWith(true)
    })

    it('restores setRawMode(false) on TTY cleanup', async () => {
        fakeStdin.isTTY = true
        fakeStdin.isRaw = false
        const p = askSecret('Password: ')
        fakeStdin.emit('data', '\n')
        await p
        expect(fakeStdin.setRawMode).toHaveBeenLastCalledWith(false)
    })

    it('writes the question prompt to stdout', async () => {
        const p = askSecret('Enter key: ')
        fakeStdin.emit('data', '\n')
        await p
        expect(process.stdout.write).toHaveBeenCalledWith('Enter key: ')
    })

    it('calls resume and setEncoding on stdin', async () => {
        const p = askSecret('> ')
        fakeStdin.emit('data', '\n')
        await p
        expect(fakeStdin.resume).toHaveBeenCalled()
        expect(fakeStdin.setEncoding).toHaveBeenCalledWith('utf8')
    })

    it('pauses stdin after resolving', async () => {
        const p = askSecret('> ')
        fakeStdin.emit('data', '\n')
        await p
        expect(fakeStdin.pause).toHaveBeenCalled()
    })

    it('trims leading/trailing whitespace from result', async () => {
        const p = askSecret('> ')
        fakeStdin.emit('data', '  trimme  ')
        fakeStdin.emit('data', '\n')
        await expect(p).resolves.toBe('trimme')
    })
})

describe('ask', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('returns the trimmed answer from readline', async () => {
        const rl = { question: vi.fn().mockResolvedValue('  hello  '), close: vi.fn() }
        mockCreateInterface.mockReturnValue(rl)
        const result = await ask('Your name? ')
        expect(result).toBe('hello')
        expect(rl.close).toHaveBeenCalled()
    })

    it('returns fallback when answer is empty', async () => {
        const rl = { question: vi.fn().mockResolvedValue('   '), close: vi.fn() }
        mockCreateInterface.mockReturnValue(rl)
        const result = await ask('> ', 'default')
        expect(result).toBe('default')
    })

    it('returns empty string when answer is empty and no fallback', async () => {
        const rl = { question: vi.fn().mockResolvedValue(''), close: vi.fn() }
        mockCreateInterface.mockReturnValue(rl)
        const result = await ask('> ')
        expect(result).toBe('')
    })

    it('calls close even if question throws', async () => {
        const rl = { question: vi.fn().mockRejectedValue(new Error('closed')), close: vi.fn() }
        mockCreateInterface.mockReturnValue(rl)
        await expect(ask('> ')).rejects.toThrow('closed')
        expect(rl.close).toHaveBeenCalled()
    })
})
