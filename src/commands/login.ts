import { Command } from 'commander'
import kleur from 'kleur'

import { ask, askSecret, readableConfigSnapshot } from '../lib/auth.js'
import { configPath, loadConfig, saveConfig } from '../lib/config.js'
import { autoDiscover, listProjects } from '../lib/discover.js'
import { authorize, registerClient } from '../lib/oauth.js'
import { loadRegistry } from '../lib/registry.js'
import { deriveAllScopes, deriveReadScopes } from '../lib/scopes.js'

const REGION_CHOICES: Record<string, string> = {
    '1': 'https://us.posthog.com',
    '2': 'https://eu.posthog.com',
}

export function registerLoginCommand(program: Command): void {
    program
        .command('login')
        .description(
            'Authenticate with PostHog via OAuth 2.0 authorization code + PKCE, registering thehogcli as a public client (DCR). Requests the full scope set every CLI tool needs, derived from the registry.'
        )
        .option('--host <url>', 'Skip region prompt; e.g. https://us.posthog.com or self-hosted.')
        .option('--manual', 'Paste a personal API key instead of running the OAuth flow.', false)
        .option('--read-only', 'Request only :read scopes (hides write actions from this session).', false)
        .option(
            '--scopes <csv>',
            'Override the derived scope list; comma-separated, e.g. "feature_flag:read,dashboard:read".'
        )
        .action(
            async (opts: {
                host?: string
                manual?: boolean
                readOnly?: boolean
                scopes?: string
            }) => {
                if (!process.stdout.isTTY) {
                    console.error(
                        kleur.red(
                            'login needs a terminal. In CI, set POSTHOG_CLI_HOST, POSTHOG_CLI_PROJECT_ID, and POSTHOG_CLI_API_KEY directly.'
                        )
                    )
                    process.exitCode = 1
                    return
                }

                try {
                    const host = opts.host ?? (await selectHost())
                    if (opts.manual) {
                        await manualLogin(host)
                        return
                    }
                    const scopes = resolveScopes(opts)
                    await oauthLogin(host, scopes)
                } catch (err) {
                    console.error(kleur.red(`login failed: ${(err as Error).message}`))
                    process.exitCode = 1
                }
            }
        )

    program
        .command('whoami')
        .description('Print the current host, project, client_id, and token expiry.')
        .action(() => {
            const cfg = loadConfig()
            console.log(readableConfigSnapshot(cfg))
            console.log(kleur.dim(`(from env vars and/or ${configPath()})`))
            if (!cfg.apiKey) {
                console.error(kleur.yellow('\nNo API key configured. Run `thehogcli login`.'))
                process.exitCode = 1
            }
        })

    program
        .command('projects')
        .description('List projects your API key can access. Marks the currently active one.')
        .action(async () => {
            const cfg = loadConfig()
            if (!cfg.apiKey) {
                console.error(kleur.red('No API key configured. Run `thehogcli login`.'))
                process.exitCode = 1
                return
            }
            const projects = await listProjects(cfg.host, cfg.apiKey)
            if (projects.length === 0) {
                console.error(kleur.yellow('No projects returned — token may be missing org access.'))
                process.exitCode = 1
                return
            }
            for (const p of projects) {
                const marker = String(cfg.projectId) === p.id ? kleur.green(' ●') : '  '
                console.log(`${marker} ${kleur.yellow(p.id.padStart(8))}  ${p.name}`)
            }
            console.log(kleur.dim(`\ncurrent: ${cfg.projectId ?? '(unset — @current)'}`))
            console.log(kleur.dim(`switch with: thehogcli use <id>`))
        })

    program
        .command('use <projectId>')
        .description('Pin a specific project for subsequent calls (overrides the server @current alias).')
        .action(async (projectId: string) => {
            if (!/^\d+$/.test(projectId)) {
                console.error(kleur.red(`project id must be numeric, got: ${projectId}`))
                process.exitCode = 1
                return
            }
            saveConfig({ project_id: projectId })
            console.log(kleur.green(`✓  active project set to ${projectId}`))
        })

    program
        .command('scopes')
        .description('Print the scope set thehogcli will request at next login.')
        .option('--read-only', 'Show only :read scopes.', false)
        .action((opts: { readOnly?: boolean }) => {
            const registry = loadRegistry()
            const scopes = opts.readOnly ? deriveReadScopes(registry) : deriveAllScopes(registry)
            console.log(`${scopes.length} scopes (derived from ${Object.keys(registry.tools).length} tools):`)
            for (const s of scopes) console.log(`  ${s}`)
        })
}

function resolveScopes(opts: { readOnly?: boolean; scopes?: string }): string[] {
    if (opts.scopes) {
        return opts.scopes
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
    }
    const registry = loadRegistry()
    return opts.readOnly ? deriveReadScopes(registry) : deriveAllScopes(registry)
}

async function selectHost(): Promise<string> {
    console.log('Select your PostHog region:')
    console.log('  1) US  (https://us.posthog.com)')
    console.log('  2) EU  (https://eu.posthog.com)')
    console.log('  3) Self-hosted / custom URL')
    const choice = await ask('> ', '1')
    const preset = REGION_CHOICES[choice]
    if (preset) return preset
    const url = await ask('Host URL: ')
    if (!/^https?:\/\//i.test(url)) {
        throw new Error('Host must be a full URL starting with http(s)://')
    }
    return url.replace(/\/$/, '')
}

async function oauthLogin(host: string, scopes: string[]): Promise<void> {
    const existing = loadConfig()
    let clientId = existing.host === host ? existing.clientId : null

    if (!clientId) {
        console.log()
        console.log(kleur.cyan('🔧  Registering thehogcli as an OAuth public client (one-time per host)…'))
        const client = await registerClient(host)
        clientId = client.clientId
        saveConfig({ host, client_id: clientId })
        console.log(`  client_id: ${kleur.dim(clientId)}`)
    } else {
        console.log(kleur.dim(`Reusing existing client_id ${clientId.slice(0, 12)}… for ${host}`))
    }

    console.log()
    console.log(kleur.cyan(`🔐  Requesting ${scopes.length} scopes…`))

    const tokens = await authorize({
        host,
        clientId,
        scopes,
        onRedirectURL: (url) => {
            console.log()
            console.log(kleur.dim('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'))
            console.log('Opening browser to authorize. If it doesn\'t open, visit:')
            console.log(`  ${kleur.cyan(url)}`)
            console.log(kleur.dim('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'))
            console.log(kleur.dim('Waiting for consent + local callback…'))
        },
    })

    console.log(kleur.dim('Discovering your default project…'))
    const discovered = await autoDiscover(host, tokens.accessToken)

    const path = saveConfig({
        host,
        api_key: tokens.accessToken,
        refresh_token: tokens.refreshToken ?? undefined,
        expires_at: tokens.expiresAt,
        client_id: clientId,
        project_id: discovered.projectId ?? undefined,
        org_id: discovered.orgId ?? undefined,
    })

    console.log()
    console.log(kleur.green('✓  Authenticated.'))
    console.log(`  host:       ${host}`)
    if (discovered.projectId) {
        const name = discovered.activeTeamName ? ` (${discovered.activeTeamName})` : ''
        console.log(`  project:    ${discovered.projectId}${name}`)
    } else if (discovered.ambiguous) {
        console.log(
            `  project:    ${kleur.yellow('ambiguous — this API key is scoped to multiple projects.')}`
        )
        console.log(kleur.dim('              Run `thehogcli projects` then `thehogcli use <id>`.'))
    } else {
        console.log(
            `  project:    ${kleur.dim('unset — calls will use the server-side `@current` alias.')}`
        )
    }
    if (discovered.orgId) {
        const name = discovered.activeOrgName ? ` (${discovered.activeOrgName})` : ''
        console.log(`  org:        ${discovered.orgId}${name}`)
    }
    console.log(`  scopes:     ${tokens.scope ?? `${scopes.length} requested`}`)
    console.log(`  saved to:   ${path}`)
}

async function manualLogin(host: string): Promise<void> {
    console.log()
    console.log(
        `${kleur.dim('Create a personal API key at')} ${host}/settings/user-api-keys ${kleur.dim('and paste it below.')}`
    )
    const apiKey = await askSecret('API key: ')
    if (!apiKey) throw new Error('No API key provided.')
    const projectId = await ask('Project id: ')
    if (!projectId) throw new Error('No project id provided.')

    const path = saveConfig({ host, api_key: apiKey, project_id: projectId })
    console.log()
    console.log(kleur.green('✓  Saved (manual PAT).'))
    console.log(`  host:       ${host}`)
    console.log(`  project_id: ${projectId}`)
    console.log(`  saved to:   ${path}`)
}
