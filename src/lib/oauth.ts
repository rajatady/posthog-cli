import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { fetch } from 'undici'

/**
 * OAuth 2.0 Authorization Code + PKCE (RFC 7636) against PostHog, with
 * Dynamic Client Registration (RFC 7591) so thehogcli registers itself as a
 * public client on first login per host — no pre-shared client_id required.
 *
 * This mirrors how the PostHog MCP server obtains tokens (see posthog/services/mcp
 * and posthog/posthog/api/oauth/dcr.py). The resulting Bearer access token is
 * accepted by every PostHog REST endpoint the CLI calls, exactly like a PAT.
 *
 * Endpoints:
 *   POST  /oauth/register   (DCR, public endpoint, rate-limited)
 *   GET   /oauth/authorize  (user consent in browser)
 *   POST  /oauth/token      (code exchange + refresh)
 */

export interface OAuthClient {
    clientId: string
    host: string
    registeredAt: number
}

export interface OAuthTokens {
    accessToken: string
    refreshToken: string | null
    expiresAt: number // ms since epoch
    scope: string | null
}

interface DCRResponse {
    client_id: string
    client_secret?: string
    client_id_issued_at?: number
}

interface TokenResponse {
    access_token: string
    refresh_token?: string
    expires_in?: number
    token_type: string
    scope?: string
}

export async function registerClient(host: string, opts?: { clientName?: string }): Promise<OAuthClient> {
    const body = {
        client_name: opts?.clientName ?? 'thehogcli',
        redirect_uris: ['http://127.0.0.1/callback'], // actual port is declared at authorize time; register with loopback pattern
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        application_type: 'native',
    }
    const url = `${host.replace(/\/$/, '')}/oauth/register`
    const res = await fetchWithCause(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })
    if (!res.ok) {
        throw new Error(`DCR failed: HTTP ${res.status} ${await res.text()}`)
    }
    const parsed = (await res.json()) as DCRResponse
    return { clientId: parsed.client_id, host, registeredAt: Date.now() }
}

/**
 * Wrap undici fetch so "fetch failed" isn't where the diagnostic ends. The
 * underlying cause — DNS failure, TLS error, blocked proxy, HTTP/2 handshake —
 * lives on `err.cause`. Surfacing it turns a useless message into an actionable one.
 */
async function fetchWithCause(url: string, init: Parameters<typeof fetch>[1]): Promise<Awaited<ReturnType<typeof fetch>>> {
    try {
        return await fetch(url, init)
    } catch (err) {
        const e = err as Error & { cause?: unknown }
        const causeChain = unwrapCause(e)
        throw new Error(`network request to ${url} failed: ${e.message}\n  cause: ${causeChain}`)
    }
}

function unwrapCause(err: unknown, depth = 0): string {
    if (!err || depth > 5) return String(err)
    if (err instanceof Error) {
        const cause = (err as Error & { cause?: unknown }).cause
        const info =
            (err as Error & { code?: string; errno?: number; hostname?: string }).code ??
            (err as { errno?: number }).errno
        const line = `${err.name}: ${err.message}${info != null ? ` (${String(info)})` : ''}`
        return cause ? `${line}\n    → ${unwrapCause(cause, depth + 1)}` : line
    }
    return String(err)
}

export interface AuthorizeOptions {
    host: string
    clientId: string
    scopes: string[]
    onRedirectURL?: (url: string) => void
    openBrowser?: boolean
    timeoutMs?: number
}

export async function authorize(opts: AuthorizeOptions): Promise<OAuthTokens> {
    const { verifier, challenge } = pkcePair()
    const state = urlSafe(randomBytes(16))
    const { port, waitForCode } = await startCallbackServer(opts.timeoutMs ?? 5 * 60 * 1000)
    const redirectUri = `http://127.0.0.1:${port}/callback`

    const authUrl = buildAuthorizeUrl({
        host: opts.host,
        clientId: opts.clientId,
        redirectUri,
        scopes: opts.scopes,
        state,
        challenge,
    })

    opts.onRedirectURL?.(authUrl)
    if (opts.openBrowser !== false) tryOpenBrowser(authUrl)

    const { code, state: returnedState } = await waitForCode
    if (returnedState !== state) {
        throw new Error('OAuth state mismatch — possible CSRF. Run login again.')
    }

    return exchangeCode({
        host: opts.host,
        clientId: opts.clientId,
        code,
        codeVerifier: verifier,
        redirectUri,
    })
}

function buildAuthorizeUrl(o: {
    host: string
    clientId: string
    redirectUri: string
    scopes: string[]
    state: string
    challenge: string
}): string {
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: o.clientId,
        redirect_uri: o.redirectUri,
        scope: o.scopes.join(' '),
        state: o.state,
        code_challenge: o.challenge,
        code_challenge_method: 'S256',
    })
    return `${o.host.replace(/\/$/, '')}/oauth/authorize?${params.toString()}`
}

async function exchangeCode(o: {
    host: string
    clientId: string
    code: string
    codeVerifier: string
    redirectUri: string
}): Promise<OAuthTokens> {
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: o.code,
        redirect_uri: o.redirectUri,
        client_id: o.clientId,
        code_verifier: o.codeVerifier,
    })
    const res = await fetchWithCause(`${o.host.replace(/\/$/, '')}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    })
    if (!res.ok) {
        throw new Error(`token exchange failed: HTTP ${res.status} ${await res.text()}`)
    }
    return parseToken(await res.json())
}

export async function refreshToken(o: {
    host: string
    clientId: string
    refreshToken: string
}): Promise<OAuthTokens> {
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: o.refreshToken,
        client_id: o.clientId,
    })
    const res = await fetchWithCause(`${o.host.replace(/\/$/, '')}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    })
    if (!res.ok) {
        throw new Error(`refresh failed: HTTP ${res.status} ${await res.text()}`)
    }
    return parseToken(await res.json())
}

function parseToken(raw: unknown): OAuthTokens {
    const t = raw as TokenResponse
    const ttl = (t.expires_in ?? 3600) * 1000
    return {
        accessToken: t.access_token,
        refreshToken: t.refresh_token ?? null,
        expiresAt: Date.now() + ttl,
        scope: t.scope ?? null,
    }
}

export function pkcePair(): { verifier: string; challenge: string } {
    const verifier = urlSafe(randomBytes(32))
    const challenge = urlSafe(createHash('sha256').update(verifier).digest())
    return { verifier, challenge }
}

function urlSafe(buf: Buffer): string {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

interface CallbackCapture {
    port: number
    waitForCode: Promise<{ code: string; state: string }>
}

function startCallbackServer(timeoutMs: number): Promise<CallbackCapture> {
    return new Promise((resolveServer, rejectServer) => {
        const deferred: {
            resolve: (v: { code: string; state: string }) => void
            reject: (err: Error) => void
        } = { resolve: () => {}, reject: () => {} }

        const waitForCode = new Promise<{ code: string; state: string }>((res, rej) => {
            deferred.resolve = res
            deferred.reject = rej
        })

        const server = createServer((req: IncomingMessage, res: ServerResponse) => {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1')
            if (url.pathname !== '/callback') {
                res.writeHead(404).end('not found')
                return
            }
            const err = url.searchParams.get('error')
            const code = url.searchParams.get('code')
            const state = url.searchParams.get('state')
            if (err) {
                sendClose(res, `Authorization failed: ${err}`)
                deferred.reject(new Error(`OAuth error: ${err} ${url.searchParams.get('error_description') ?? ''}`))
            } else if (code && state) {
                sendClose(res, 'Authorization complete. You can close this tab.')
                deferred.resolve({ code, state })
            } else {
                sendClose(res, 'Missing code or state in callback.')
                deferred.reject(new Error('OAuth callback missing code or state.'))
            }
            setTimeout(() => server.close(), 100)
        })

        const timer = setTimeout(() => {
            server.close()
            deferred.reject(new Error('OAuth login timed out.'))
        }, timeoutMs)
        waitForCode.finally(() => clearTimeout(timer)).catch(() => {})

        server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            if (typeof address === 'object' && address !== null) {
                resolveServer({ port: address.port, waitForCode })
            } else {
                rejectServer(new Error('Failed to bind loopback callback server'))
            }
        })
        server.on('error', (e) => rejectServer(e as Error))
    })
}

function sendClose(res: ServerResponse, message: string): void {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(
        `<!doctype html><html><head><title>thehogcli</title><style>body{font-family:system-ui;padding:3rem;max-width:480px;margin:0 auto;color:#333}h1{font-size:1.25rem}</style></head><body><h1>${escapeHtml(message)}</h1><p>Return to your terminal.</p><script>setTimeout(()=>window.close(),500)</script></body></html>`
    )
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function tryOpenBrowser(url: string): void {
    const cmd =
        process.platform === 'darwin'
            ? ['open', url]
            : process.platform === 'win32'
              ? ['cmd', '/C', 'start', '""', url]
              : ['xdg-open', url]
    try {
        const child = spawn(cmd[0]!, cmd.slice(1), { stdio: 'ignore', detached: true })
        child.unref()
    } catch {
        // fall through — URL is printed for manual open
    }
}
