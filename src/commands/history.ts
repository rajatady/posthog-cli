import { Command } from 'commander'
import kleur from 'kleur'

import { History, formatRelativeTime, resolveHistoryPath } from '../lib/history'

export function registerHistoryCommands(program: Command): void {
    const history = program
        .command('history')
        .description('View, re-run, or fork past CLI invocations saved in .thehogcli/history.db.')

    history
        .command('list', { isDefault: true })
        .description('Paginated list of past invocations (newest first).')
        .option('-n, --limit <n>', 'How many entries to show.', '25')
        .option('--offset <n>', 'Skip this many entries.', '0')
        .option('--module <name>', 'Filter by module slug.')
        .option('--tool <name>', 'Filter by tool name.')
        .action((opts: { limit: string; offset: string; module?: string; tool?: string }) => {
            const h = new History(resolveHistoryPath())
            const rows = h.list({
                limit: Number.parseInt(opts.limit, 10),
                offset: Number.parseInt(opts.offset, 10),
                module: opts.module,
                tool: opts.tool,
            })
            if (rows.length === 0) {
                console.log(kleur.dim('(no history yet — run any tool to populate)'))
                return
            }
            for (const r of rows) {
                const id = r.id.slice(0, 8)
                const rel = formatRelativeTime(r.createdAt)
                const abs = new Date(r.createdAt).toISOString()
                const status = r.exitCode === 0 ? kleur.green('ok') : kleur.red(`exit ${r.exitCode}`)
                const desc = truncate(r.description, 60)
                const preview = truncate(summarize(r.params), 40)
                console.log(
                    `${kleur.yellow(id)}  ${rel}  (${kleur.dim(abs)})  ${kleur.cyan(r.tool)}  ${status}`
                )
                console.log(`          ${kleur.white(desc)}`)
                if (preview) console.log(`          ${kleur.dim(preview)}`)
            }
            const total = h.count()
            console.error(kleur.dim(`\nshowing ${rows.length} of ${total} total`))
        })

    history
        .command('show <id>')
        .description('Show full details for a history entry (id or 8-char prefix).')
        .action((id: string) => {
            const h = new History(resolveHistoryPath())
            const e = h.get(id)
            if (!e) {
                console.error(kleur.red(`no history entry matching ${id}`))
                process.exitCode = 1
                return
            }
            console.log(
                JSON.stringify(
                    {
                        id: e.id,
                        created_at: new Date(e.createdAt).toISOString(),
                        tool: e.tool,
                        module: e.module,
                        description: e.description,
                        method: e.method,
                        path: e.path,
                        params: e.params,
                        response_preview: e.responsePreview,
                        exit_code: e.exitCode,
                        duration_ms: e.durationMs,
                        forked_from: e.forkedFrom,
                    },
                    null,
                    2
                )
            )
        })

    history
        .command('rerun <id>')
        .description('Stub. Re-run a historical invocation with the same params.')
        .action((id: string) => {
            console.error(
                kleur.yellow(
                    `rerun is not yet wired to the tool executor. Use 'thehogcli history show ${id}' for now.`
                )
            )
            process.exitCode = 2
        })

    history
        .command('fork <id>')
        .description('Stub. Fork a historical invocation, edit params, save as a new entry.')
        .action((id: string) => {
            console.error(
                kleur.yellow(
                    `fork is not yet wired. Use 'thehogcli history show ${id}' then re-invoke manually.`
                )
            )
            process.exitCode = 2
        })
}

function truncate(s: string, n: number): string {
    if (s.length <= n) return s
    return `${s.slice(0, n - 1)}…`
}

function summarize(params: Record<string, unknown>): string {
    const entries = Object.entries(params)
    if (entries.length === 0) return ''
    return entries
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ')
}
