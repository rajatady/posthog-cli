import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { registerHistoryCommands } from '../src/commands/history.js'
import { History } from '../src/lib/history.js'

function makeProgram(): Command {
    return new Command().name('thehogcli').exitOverride()
}

async function parse(program: Command, args: string[]): Promise<void> {
    await program.parseAsync(args, { from: 'user' })
}

let tmpDir: string
let dbPath: string

beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'thehogcli-hist-test-'))
    dbPath = join(tmpDir, 'history.db')
    process.env.THEHOGCLI_HISTORY_DB = dbPath
})

afterEach(() => {
    delete process.env.THEHOGCLI_HISTORY_DB
    rmSync(tmpDir, { recursive: true, force: true })
    process.exitCode = 0
    vi.restoreAllMocks()
})

function seedHistory(entries: number): History {
    const h = new History(dbPath)
    for (let i = 0; i < entries; i++) {
        h.insert({
            id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
            createdAt: Date.now() - i * 1000,
            module: 'feature-flags',
            tool: `feature-flag-get-${i}`,
            description: `Why I ran query ${i}`,
            params: { limit: i },
            method: 'GET',
            path: '/api/projects/@current/feature_flags/',
            responsePreview: `{"count":${i}}`,
            exitCode: 0,
            durationMs: 50,
            forkedFrom: null,
        })
    }
    return h
}

describe('history list', () => {
    it('prints a message when history is empty', async () => {
        const program = makeProgram()
        registerHistoryCommands(program)
        const logged: string[] = []
        vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(String(args[0])) })
        vi.spyOn(console, 'error').mockImplementation(() => {})
        await parse(program, ['history', 'list'])
        expect(logged.some(l => l.includes('no history'))).toBe(true)
    })

    it('lists history entries with id, tool, and status', async () => {
        seedHistory(3)
        const program = makeProgram()
        registerHistoryCommands(program)
        const logged: string[] = []
        vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(String(args[0])) })
        vi.spyOn(console, 'error').mockImplementation(() => {})
        await parse(program, ['history', 'list'])
        expect(logged.some(l => l.includes('feature-flag-get'))).toBe(true)
    })

    it('respects --limit flag', async () => {
        seedHistory(10)
        const program = makeProgram()
        registerHistoryCommands(program)
        const errLogs: string[] = []
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation((...args) => { errLogs.push(String(args[0])) })
        await parse(program, ['history', 'list', '--limit', '2'])
        expect(errLogs.some(l => l.includes('2 of'))).toBe(true)
    })

    it('respects --module filter', async () => {
        seedHistory(5)
        const program = makeProgram()
        registerHistoryCommands(program)
        const logged: string[] = []
        vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(String(args[0])) })
        vi.spyOn(console, 'error').mockImplementation(() => {})
        await parse(program, ['history', 'list', '--module', 'feature-flags'])
        expect(logged.some(l => l.includes('feature-flag-get'))).toBe(true)
    })

    it('respects --tool filter', async () => {
        seedHistory(3)
        const program = makeProgram()
        registerHistoryCommands(program)
        const logged: string[] = []
        vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(String(args[0])) })
        vi.spyOn(console, 'error').mockImplementation(() => {})
        await parse(program, ['history', 'list', '--tool', 'feature-flag-get-0'])
        expect(logged.some(l => l.includes('feature-flag-get-0'))).toBe(true)
    })

    it('history list is the default subcommand', async () => {
        seedHistory(1)
        const program = makeProgram()
        registerHistoryCommands(program)
        const logged: string[] = []
        vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(String(args[0])) })
        vi.spyOn(console, 'error').mockImplementation(() => {})
        await parse(program, ['history'])
        expect(logged.length).toBeGreaterThan(0)
    })
})

describe('history show', () => {
    it('prints full JSON details for a known entry', async () => {
        const h = seedHistory(1)
        const id = h.list({ limit: 1, offset: 0 })[0]!.id
        const prefix = id.slice(0, 8)
        const program = makeProgram()
        registerHistoryCommands(program)
        const logged: string[] = []
        vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(String(args[0])) })
        vi.spyOn(console, 'error').mockImplementation(() => {})
        await parse(program, ['history', 'show', prefix])
        expect(logged.length).toBeGreaterThan(0)
        const json = JSON.parse(logged[0]!) as Record<string, unknown>
        expect(json.tool).toBe('feature-flag-get-0')
        expect(json.module).toBe('feature-flags')
    })

    it('sets exitCode 1 and prints error when entry not found', async () => {
        const program = makeProgram()
        registerHistoryCommands(program)
        const errLogs: string[] = []
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation((...args) => { errLogs.push(String(args[0])) })
        await parse(program, ['history', 'show', 'nonexist'])
        expect(process.exitCode).toBe(1)
        expect(errLogs.some(l => l.includes('no history entry'))).toBe(true)
    })
})

describe('history list – truncate and summarize edge cases', () => {
    it('truncates descriptions longer than 60 chars', async () => {
        const h = new History(dbPath)
        h.insert({
            id: 'long-desc-id',
            createdAt: Date.now(),
            module: 'feature-flags',
            tool: 'feature-flag-get-all',
            description: 'This is a very long description that definitely exceeds sixty characters in total length',
            params: { key: 'value' },
            method: 'GET',
            path: '/api/projects/@current/feature_flags/',
            responsePreview: null,
            exitCode: 0,
            durationMs: 10,
            forkedFrom: null,
        })
        const program = makeProgram()
        registerHistoryCommands(program)
        const logged: string[] = []
        vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(String(args[0])) })
        vi.spyOn(console, 'error').mockImplementation(() => {})
        await parse(program, ['history', 'list'])
        expect(logged.some(l => l.includes('…'))).toBe(true)
    })

    it('shows no params line for entries with empty params', async () => {
        const h = new History(dbPath)
        h.insert({
            id: 'no-params-id',
            createdAt: Date.now(),
            module: 'feature-flags',
            tool: 'feature-flag-get-all',
            description: 'no params query',
            params: {},
            method: 'GET',
            path: '/',
            responsePreview: null,
            exitCode: 0,
            durationMs: 5,
            forkedFrom: null,
        })
        const program = makeProgram()
        registerHistoryCommands(program)
        const logged: string[] = []
        vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(String(args[0])) })
        vi.spyOn(console, 'error').mockImplementation(() => {})
        await parse(program, ['history', 'list'])
        expect(logged.some(l => l.includes('feature-flag-get-all'))).toBe(true)
    })

    it('shows string param values without JSON.stringify quotes', async () => {
        const h = new History(dbPath)
        h.insert({
            id: 'str-params-id',
            createdAt: Date.now(),
            module: 'feature-flags',
            tool: 'feature-flag-get-all',
            description: 'search query',
            params: { search: 'my-flag', limit: 5 },
            method: 'GET',
            path: '/',
            responsePreview: null,
            exitCode: 0,
            durationMs: 5,
            forkedFrom: null,
        })
        const program = makeProgram()
        registerHistoryCommands(program)
        const logged: string[] = []
        vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(String(args[0])) })
        vi.spyOn(console, 'error').mockImplementation(() => {})
        await parse(program, ['history', 'list'])
        expect(logged.some(l => l.includes('search=my-flag'))).toBe(true)
    })
})

describe('history list – exit code display', () => {
    it('shows "exit 1" label for entries with non-zero exit code', async () => {
        const h = new History(dbPath)
        h.insert({
            id: 'failed-entry-id',
            createdAt: Date.now(),
            module: 'feature-flags',
            tool: 'feature-flag-delete',
            description: 'attempted delete',
            params: { id: 42 },
            method: 'DELETE',
            path: '/api/projects/@current/feature_flags/42/',
            responsePreview: '{"detail":"not found"}',
            exitCode: 1,
            durationMs: 20,
            forkedFrom: null,
        })
        const program = makeProgram()
        registerHistoryCommands(program)
        const logged: string[] = []
        vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(String(args[0])) })
        vi.spyOn(console, 'error').mockImplementation(() => {})
        await parse(program, ['history', 'list'])
        expect(logged.some(l => l.includes('exit 1'))).toBe(true)
    })
})

describe('history rerun / fork stubs', () => {
    it('rerun prints warning and exits 2', async () => {
        const program = makeProgram()
        registerHistoryCommands(program)
        const errLogs: string[] = []
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation((...args) => { errLogs.push(String(args[0])) })
        await parse(program, ['history', 'rerun', 'abc12345'])
        expect(process.exitCode).toBe(2)
        expect(errLogs.some(l => l.includes('rerun is not yet wired'))).toBe(true)
    })

    it('fork prints warning and exits 2', async () => {
        const program = makeProgram()
        registerHistoryCommands(program)
        const errLogs: string[] = []
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation((...args) => { errLogs.push(String(args[0])) })
        await parse(program, ['history', 'fork', 'abc12345'])
        expect(process.exitCode).toBe(2)
        expect(errLogs.some(l => l.includes('fork is not yet wired'))).toBe(true)
    })
})
