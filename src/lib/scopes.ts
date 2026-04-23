import type { Registry } from './registry'

/**
 * Derive the full scope set thehogcli ever needs as the union of every tool's
 * declared `scopes` in registry.json. No manual maintenance required — when
 * PostHog adds new tools upstream, the scope list grows with them on the next
 * `npm run build:extract`.
 *
 * This is the authoritative answer to "what scopes should we request at login?"
 * and keeps the browser consent screen showing exactly what the CLI can do and
 * nothing more.
 */
export function deriveAllScopes(registry: Registry): string[] {
    const set = new Set<string>()
    for (const tool of Object.values(registry.tools)) {
        for (const scope of tool.scopes) set.add(scope)
    }
    return Array.from(set).sort()
}

/** Scopes that are strictly read-only (end with `:read`). */
export function deriveReadScopes(registry: Registry): string[] {
    return deriveAllScopes(registry).filter((s) => s.endsWith(':read'))
}
