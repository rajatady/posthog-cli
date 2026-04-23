import { createInterface } from 'node:readline/promises'

import type { Config } from './config.js'

/** Prompt for a line of input. Returns trimmed answer, or `fallback` if empty. */
export async function ask(question: string, fallback?: string): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
        const answer = (await rl.question(question)).trim()
        return answer.length > 0 ? answer : (fallback ?? '')
    } finally {
        rl.close()
    }
}

/** Read a line from stdin without echoing — for pasting secrets. */
export async function askSecret(question: string): Promise<string> {
    process.stdout.write(question)
    return new Promise((resolve, reject) => {
        const stdin = process.stdin
        const wasRaw = stdin.isTTY ? stdin.isRaw : false
        if (stdin.isTTY) stdin.setRawMode(true)
        stdin.resume()
        stdin.setEncoding('utf8')

        let buffer = ''
        const onData = (chunk: string): void => {
            for (const ch of chunk) {
                if (ch === '\n' || ch === '\r' || ch === '') {
                    cleanup()
                    process.stdout.write('\n')
                    resolve(buffer.trim())
                    return
                }
                if (ch === '') {
                    cleanup()
                    reject(new Error('cancelled'))
                    return
                }
                if (ch === '' || ch === '\b') {
                    buffer = buffer.slice(0, -1)
                    continue
                }
                buffer += ch
            }
        }
        const cleanup = (): void => {
            stdin.removeListener('data', onData)
            if (stdin.isTTY) stdin.setRawMode(wasRaw)
            stdin.pause()
        }
        stdin.on('data', onData)
    })
}

export function readableConfigSnapshot(cfg: Config): string {
    const apiKey = cfg.apiKey ? `${cfg.apiKey.slice(0, 8)}…` : '(none)'
    const expiry =
        cfg.expiresAt == null
            ? '(no expiry — PAT or manual)'
            : cfg.expiresAt > Date.now()
              ? `expires in ${Math.floor((cfg.expiresAt - Date.now()) / 1000 / 60)} min`
              : 'expired (will auto-refresh)'
    return [
        `host:       ${cfg.host}`,
        `project_id: ${cfg.projectId ?? '(none)'}`,
        `api_key:    ${apiKey}   ${expiry}`,
        `client_id:  ${cfg.clientId ?? '(none — no OAuth registration yet)'}`,
    ].join('\n')
}
