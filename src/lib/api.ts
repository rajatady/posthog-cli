import { fetch } from 'undici'

import type { Config } from './config'
import { saveConfig } from './config'
import { refreshToken } from './oauth'
import type { HttpMethod, HttpSpec } from './registry'

export interface ResolvedRequest {
    method: HttpMethod
    url: string
    headers: Record<string, string>
    body: unknown | null
}

export interface ApiResult {
    status: number
    body: unknown
    durationMs: number
}

/** Resolve an HttpSpec + user-provided params into a concrete request. */
export function resolveRequest(
    cfg: Config,
    spec: HttpSpec,
    params: Record<string, unknown>
): ResolvedRequest {
    if (!cfg.apiKey) {
        throw new Error(
            'Missing API key. Set POSTHOG_CLI_API_KEY or run `thehogcli login`.'
        )
    }

    let path = spec.path
    // Prefer the server-side `@current` alias over a required user-supplied id.
    // PostHog's routing (posthog/api/routing.py, team.py) expands `@current` to the
    // user's active team/org for any authenticated request, so a CLI user who just
    // ran `login` can execute tools without ever being asked "which project?".
    // An explicit projectId / orgId in cfg (from --project-id, env var, or `use`)
    // still wins when the user wants to pin a specific target.
    if (path.includes('{project_id}')) {
        const resolved = cfg.projectId ?? '@current'
        path = path.replace('{project_id}', encodeURIComponent(resolved))
    }
    if (path.includes('{organization_id}')) {
        const resolved = cfg.orgId ?? '@current'
        path = path.replace('{organization_id}', encodeURIComponent(resolved))
    }
    for (const pp of spec.pathParams) {
        const v = params[pp]
        if (v == null) {
            throw new Error(`Missing required path parameter: --${toKebab(pp)}`)
        }
        path = path.replace(`{${pp}}`, encodeURIComponent(String(v)))
    }

    const query = new URLSearchParams()
    for (const qp of spec.queryParams) {
        const v = params[qp]
        if (v == null) continue
        if (Array.isArray(v)) {
            for (const item of v) query.append(qp, String(item))
        } else {
            query.append(qp, String(v))
        }
    }
    const qs = query.toString()
    const url = `${cfg.host.replace(/\/$/, '')}${path}${qs ? `?${qs}` : ''}`

    let body: Record<string, unknown> | null = null
    if (spec.bodyParams.length > 0 && spec.method !== 'GET' && spec.method !== 'DELETE') {
        body = {}
        for (const bp of spec.bodyParams) {
            if (params[bp] !== undefined) body[bp] = params[bp]
        }
    }

    const headers: Record<string, string> = {
        Authorization: `Bearer ${cfg.apiKey}`,
        Accept: 'application/json',
        'User-Agent': 'thehogcli/0.0.1',
    }
    if (body !== null) headers['Content-Type'] = 'application/json'

    return { method: spec.method, url, headers, body }
}

export async function executeRequest(req: ResolvedRequest, cfg?: Config): Promise<ApiResult> {
    const start = Date.now()
    let res = await doFetch(req)

    // Auto-refresh once on 401 if we have the OAuth pieces to do so. The MCP token
    // exchange returns both access_token and refresh_token; PATs don't, in which case
    // cfg.refreshToken is null and we skip the retry.
    if (res.status === 401 && cfg?.refreshToken && cfg.clientId) {
        const refreshed = await tryRefresh(cfg)
        if (refreshed) {
            const retryHeaders = { ...req.headers, Authorization: `Bearer ${refreshed}` }
            res = await doFetch({ ...req, headers: retryHeaders })
        }
    }

    const text = await res.text()
    let parsed: unknown = text
    if (text) {
        try {
            parsed = JSON.parse(text)
        } catch {
            parsed = text
        }
    }
    return { status: res.status, body: parsed, durationMs: Date.now() - start }
}

async function doFetch(req: ResolvedRequest): ReturnType<typeof fetch> {
    return fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body == null ? undefined : JSON.stringify(req.body),
    })
}

async function tryRefresh(cfg: Config): Promise<string | null> {
    if (!cfg.refreshToken || !cfg.clientId) return null
    try {
        const t = await refreshToken({
            host: cfg.host,
            clientId: cfg.clientId,
            refreshToken: cfg.refreshToken,
        })
        saveConfig({
            host: cfg.host,
            api_key: t.accessToken,
            refresh_token: t.refreshToken ?? cfg.refreshToken,
            expires_at: t.expiresAt,
            client_id: cfg.clientId,
        })
        return t.accessToken
    } catch {
        return null
    }
}

export function toKebab(snake: string): string {
    return snake.replace(/_/g, '-')
}

export function fromKebab(kebab: string): string {
    return kebab.replace(/-/g, '_')
}

/** Redact the Authorization header for dry-run / log display. */
export function redactHeaders(h: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = { ...h }
    if (out.Authorization) out.Authorization = 'Bearer <redacted>'
    return out
}
