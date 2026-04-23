import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface Config {
    host: string
    apiKey: string | null
    refreshToken: string | null
    clientId: string | null
    expiresAt: number | null
    projectId: string | null
    orgId: string | null
}

const DEFAULT_HOST = 'https://us.posthog.com'
const USER_CONFIG_PATH = join(homedir(), '.thehogcli', 'config.json')

interface UserConfigFile {
    host?: string
    api_key?: string
    refresh_token?: string
    client_id?: string
    expires_at?: number
    project_id?: string | number
    org_id?: string
}

function readUserConfig(): UserConfigFile {
    if (!existsSync(USER_CONFIG_PATH)) return {}
    try {
        return JSON.parse(readFileSync(USER_CONFIG_PATH, 'utf8')) as UserConfigFile
    } catch {
        return {}
    }
}

export function loadConfig(): Config {
    const file = readUserConfig()
    const apiKey = envOr('POSTHOG_CLI_API_KEY', file.api_key) ?? null
    const host = envOr('POSTHOG_CLI_HOST', file.host) ?? DEFAULT_HOST
    const projectId =
        envOr('POSTHOG_CLI_PROJECT_ID', file.project_id != null ? String(file.project_id) : undefined) ??
        null
    const orgId = envOr('POSTHOG_CLI_ORG_ID', file.org_id) ?? null
    return {
        host,
        apiKey,
        refreshToken: file.refresh_token ?? null,
        clientId: file.client_id ?? null,
        expiresAt: file.expires_at ?? null,
        projectId,
        orgId,
    }
}

/**
 * Read an env var, treating empty string as absent. `VAR=` on the command line
 * sets `process.env.VAR` to `""`, which `??` would accept — but empty strings
 * are never valid ids/tokens/URLs, so the fallback should win.
 */
function envOr(name: string, fallback: string | undefined): string | undefined {
    const v = process.env[name]
    if (v != null && v !== '') return v
    return fallback
}

export function saveConfig(patch: Partial<UserConfigFile>): string {
    const existing = readUserConfig()
    const merged: UserConfigFile = { ...existing, ...patch }
    mkdirSync(dirname(USER_CONFIG_PATH), { recursive: true })
    writeFileSync(USER_CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 })
    chmodSync(USER_CONFIG_PATH, 0o600)
    return USER_CONFIG_PATH
}

export function configPath(): string {
    return USER_CONFIG_PATH
}
