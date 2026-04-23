import { spawnSync } from 'node:child_process'
import { Command } from 'commander'
import kleur from 'kleur'

import { loadConfig } from '../lib/config.js'
import { History, resolveHistoryPath } from '../lib/history.js'
import { VERSION } from '../lib/version.js'

const GITHUB_ISSUES_URL = 'https://github.com/rajatady/posthog-cli/issues/new'

// Fields deliberately excluded from the public report:
//   params        — may contain query payloads, filter values, user-supplied strings
//   responsePreview — may contain PII from API responses (emails, names, event data)
//   projectId     — numeric internal ID; not needed to reproduce a CLI bug
//   apiKey        — never in config.ts's return value, but belt-and-suspenders

export function registerReportBugCommand(parent: Command): Command {
    const cmd = parent
        .command('report-bug')
        .description(
            'Open a pre-filled GitHub issue with sanitised CLI context (no params, no response data).'
        )
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
        historyLines,
    })

    const url = `${GITHUB_ISSUES_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`

    console.error(kleur.yellow(
        '⚠  Review the issue form before submitting — remove anything sensitive before posting.'
    ))
    console.error(kleur.dim('Opening GitHub issue form in your browser…'))
    console.error(kleur.dim(`If it does not open: ${url}`))

    tryOpenBrowser(url)
}

interface BodyContext {
    version: string
    platform: string
    nodeVersion: string
    host: string
    historyLines: string[]
}

function buildBody(ctx: BodyContext): string {
    return `<!-- ⚠️ STOP — before submitting, check this form for sensitive data.
     Remove any API keys, personal information, query contents, or response
     payloads that may have been added manually. params and response data
     are intentionally excluded by the CLI. -->

## Environment

| Key | Value |
|-----|-------|
| thehogcli version | \`${ctx.version}\` |
| OS | \`${ctx.platform}\` |
| Node | \`${ctx.nodeVersion}\` |
| Host | \`${ctx.host}\` |

## What happened?

[FILL IN: describe the unexpected behaviour]

## Expected behaviour

[FILL IN: what should have happened instead]

## Steps to reproduce

[FILL IN: exact command(s) to reproduce — do not paste API keys or query data]

\`\`\`bash
thehogcli [FILL IN command]
\`\`\`

## CLI history (tool names, exit codes, timings — no params or response data)

<details>
<summary>Recent calls</summary>

\`\`\`
${ctx.historyLines.join('\n\n')}
\`\`\`

</details>

## Additional context

[FILL IN: anything else — error output, screenshots, related issues]
`
}

// Only safe, non-PII fields are included.
// params and responsePreview are intentionally omitted — they can contain
// user-supplied query payloads, filter values, or API response data.
function formatEntry(e: {
    id: string
    createdAt: number
    module: string
    tool: string
    description: string
    method: string | null
    path: string | null
    exitCode: number
    durationMs: number
}): string {
    const ts = new Date(e.createdAt).toISOString()
    const status = e.exitCode === 0 ? 'ok' : `exit ${e.exitCode}`
    const lines = [
        `[${e.id.slice(0, 8)}] ${ts}  ${status}  ${e.durationMs}ms`,
        `  tool:    ${e.module} / ${e.tool}`,
    ]
    if (e.method && e.path) lines.push(`  request: ${e.method} ${e.path}`)
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
