import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'

export interface HistoryEntry {
    id: string
    createdAt: number
    module: string
    tool: string
    description: string
    params: Record<string, unknown>
    method: string | null
    path: string | null
    responsePreview: string | null
    exitCode: number
    durationMs: number
    forkedFrom: string | null
}

export class History {
    private db: Database.Database

    constructor(dbPath: string) {
        const dir = dirname(dbPath)
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        this.db = new Database(dbPath)
        this.db.pragma('journal_mode = WAL')
        this.init()
    }

    private init(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS entries (
                id TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL,
                module TEXT NOT NULL,
                tool TEXT NOT NULL,
                description TEXT NOT NULL,
                params_json TEXT NOT NULL,
                method TEXT,
                path TEXT,
                response_preview TEXT,
                exit_code INTEGER NOT NULL,
                duration_ms INTEGER NOT NULL,
                forked_from TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_entries_module ON entries(module);
            CREATE INDEX IF NOT EXISTS idx_entries_tool ON entries(tool);
        `)
    }

    insert(e: HistoryEntry): void {
        this.db
            .prepare(
                `INSERT INTO entries (id, created_at, module, tool, description, params_json,
                    method, path, response_preview, exit_code, duration_ms, forked_from)
                 VALUES (@id, @created_at, @module, @tool, @description, @params_json,
                    @method, @path, @response_preview, @exit_code, @duration_ms, @forked_from)`
            )
            .run({
                id: e.id,
                created_at: e.createdAt,
                module: e.module,
                tool: e.tool,
                description: e.description,
                params_json: JSON.stringify(e.params),
                method: e.method,
                path: e.path,
                response_preview: e.responsePreview,
                exit_code: e.exitCode,
                duration_ms: e.durationMs,
                forked_from: e.forkedFrom,
            })
    }

    list(opts: {
        limit?: number
        offset?: number
        module?: string
        tool?: string
    } = {}): HistoryEntry[] {
        const limit = opts.limit ?? 25
        const offset = opts.offset ?? 0
        const conditions: string[] = []
        const bindings: unknown[] = []
        if (opts.module) {
            conditions.push('module = ?')
            bindings.push(opts.module)
        }
        if (opts.tool) {
            conditions.push('tool = ?')
            bindings.push(opts.tool)
        }
        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
        bindings.push(limit, offset)
        const rows = this.db
            .prepare(
                `SELECT * FROM entries ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
            )
            .all(...bindings) as Record<string, unknown>[]
        return rows.map(rowToEntry)
    }

    get(id: string): HistoryEntry | null {
        const row = this.db
            .prepare('SELECT * FROM entries WHERE id = ? OR id LIKE ? LIMIT 1')
            .get(id, `${id}%`) as Record<string, unknown> | undefined
        return row ? rowToEntry(row) : null
    }

    count(): number {
        const row = this.db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number }
        return row.n
    }
}

function rowToEntry(row: Record<string, unknown>): HistoryEntry {
    return {
        id: row.id as string,
        createdAt: row.created_at as number,
        module: row.module as string,
        tool: row.tool as string,
        description: row.description as string,
        params: JSON.parse(row.params_json as string) as Record<string, unknown>,
        method: (row.method as string | null) ?? null,
        path: (row.path as string | null) ?? null,
        responsePreview: (row.response_preview as string | null) ?? null,
        exitCode: row.exit_code as number,
        durationMs: row.duration_ms as number,
        forkedFrom: (row.forked_from as string | null) ?? null,
    }
}

export function defaultHistoryPath(cwd: string = process.cwd()): string {
    return resolve(cwd, '.thehogcli', 'history.db')
}

export function formatRelativeTime(fromMs: number, nowMs: number = Date.now()): string {
    let delta = Math.max(0, Math.floor((nowMs - fromMs) / 1000))
    if (delta < 1) return 'just now'
    const units: [string, number][] = [
        ['day', 86400],
        ['hour', 3600],
        ['minute', 60],
        ['second', 1],
    ]
    const parts: string[] = []
    for (const [label, sec] of units) {
        const n = Math.floor(delta / sec)
        if (n > 0) {
            parts.push(`${n} ${label}${n === 1 ? '' : 's'}`)
            delta -= n * sec
        }
        if (parts.length === 2) break
    }
    return `${parts.join(', ')} ago`
}

/** Join resolved path segments into an absolute history DB path. Exposed so tests can patch it. */
export function resolveHistoryPath(explicit?: string): string {
    if (explicit) return explicit
    if (process.env.THEHOGCLI_HISTORY_DB) return process.env.THEHOGCLI_HISTORY_DB
    return defaultHistoryPath()
}

