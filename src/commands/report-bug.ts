import { spawnSync } from 'node:child_process'
import { Command } from 'commander'
import kleur from 'kleur'

import { loadConfig } from '../lib/config.js'
import { History, resolveHistoryPath } from '../lib/history.js'
import { VERSION } from '../lib/version.js'

const GITHUB_ISSUES_URL = 'https://github.com/rajatady/posthog-cli/issues/new'

export function registerReportBugCommand(parent: Command): Command {
    const cmd = parent
        .command('report-bug')
        .description('Open a pre-filled GitHub issue with CLI session context for bug reproduction.')
        .option('--id <prefix>', 'Attach a specific history entry (prefix or full UUID).')
        .option('--last <n>', 'Attach the last N history entries (default: 5).', '5')
        .option('--title <text>', 'Issue title (pre-fills the GitHub form).')

    cmd.action((rawOpts: { id?: string; last?: string; title?: string }) => {
        reportBug(rawOpts)
    })

    return cmd
}

function reportBug(opts: { id?: string; last?: string; title?: string }): void {
    const cfg = loadConfig()

    let historyLines: string[] = []
    try {
        const history = new History(resolveHistoryPath())
        if (opts.id) {
            const entry = history.get(opts.id)
            if (!entry) {
                console.error(kleur.red(`No history entry matching "${opts.id}".`))
                process.exitCode = 1
                return
            }
            historyLines = [formatEntry(entry)]
        } else {
            /* v8 ignore next */
            const n = Math.max(1, parseInt(opts.last ?? '5', 10) || 5)
            const entries = history.list({ limit: n })
            historyLines = entries.length > 0
                ? entries.map(formatEntry)
                : ['(no history entries found)']
        }
    } catch {
        historyLines = ['(history unavailable)']
    }

    const title = opts.title ?? '[FILL IN: one-line description of the bug]'

    const body = buildBody({
        version: VERSION,
        platform: process.platform,
        nodeVersion: process.version,
        host: cfg.host,
        projectId: cfg.projectId ?? '@current',
        historyLines,
    })

    const url = `${GITHUB_ISSUES_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`

    console.error(kleur.dim('Opening GitHub issue form in your browser…'))
    console.error(kleur.dim(`If it does not open: ${url}`))

    tryOpenBrowser(url)
}

interface BodyContext {
    version: string
    platform: string
    nodeVersion: string
    host: string
    projectId: string
    historyLines: string[]
}

function buildBody(ctx: BodyContext): string {
    return `## Environment

| Key | Value |
|-----|-------|
| thehogcli version | \`${ctx.version}\` |
| OS | \`${ctx.platform}\` |
| Node | \`${ctx.nodeVersion}\` |
| Host | \`${ctx.host}\` |
| Project | \`${ctx.projectId}\` |

## What happened?

[FILL IN: describe the unexpected behaviour]

## Expected behaviour

[FILL IN: what should have happened instead]

## Steps to reproduce

[FILL IN: exact command(s) to reproduce]

\`\`\`bash
thehogcli [FILL IN command]
\`\`\`

## CLI session replay (last calls)

<details>
<summary>History entries</summary>

\`\`\`
${ctx.historyLines.join('\n\n')}
\`\`\`

</details>

## Additional context

[FILL IN: anything else — error output, screenshots, related issues]
`
}

function formatEntry(e: {
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
}): string {
    const ts = new Date(e.createdAt).toISOString()
    const status = e.exitCode === 0 ? 'ok' : `exit ${e.exitCode}`
    const lines = [
        `[${e.id.slice(0, 8)}] ${ts}  ${status}  ${e.durationMs}ms`,
        `  tool:    ${e.module} / ${e.tool}`,
        `  why:     ${e.description}`,
    ]
    if (e.method && e.path) lines.push(`  request: ${e.method} ${e.path}`)
    if (Object.keys(e.params).length > 0) {
        lines.push(`  params:  ${JSON.stringify(e.params)}`)
    }
    if (e.responsePreview) {
        const preview = e.responsePreview.length > 300
            ? `${e.responsePreview.slice(0, 300)}…`
            : e.responsePreview
        lines.push(`  preview: ${preview}`)
    }
    return lines.join('\n')
}

function tryOpenBrowser(url: string): void {
    const cmd =
        process.platform === 'darwin'
            ? ['open', url]
            : process.platform === 'win32'
              ? ['cmd', '/C', 'start', '""', url]
              : ['xdg-open', url]
    try {
        spawnSync(cmd[0]!, cmd.slice(1), { stdio: 'ignore' })
    } catch {
        // URL already printed above
    }
}
