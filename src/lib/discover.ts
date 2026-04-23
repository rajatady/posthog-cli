import { fetch } from 'undici'

/**
 * Resolve the user's default project and organization given a freshly-minted
 * access token. Mirrors the decision tree in
 * posthog/services/mcp/src/lib/StateManager.ts (_getDefaultOrganizationAndProject)
 * so `thehogcli` behaves the same as the MCP when the user doesn't pin a project:
 *
 *   1. Query the token (`/api/personal_api_keys/@current`) for `scoped_teams`.
 *      - If exactly one → that's the project.
 *      - If >1 → ambiguous; caller must prompt/pick.
 *   2. Query the user (`/api/users/@me/`) for `team.id` and `organization.id`.
 *      When the token isn't scoped to a specific org, or is scoped to the
 *      active org, use the user's active team.
 *   3. Otherwise list the org's projects and pick the first one.
 *
 * Any failure leaves the caller to fall back to `@current` at request time —
 * which already works for most endpoints.
 */

export interface Discovered {
    projectId: string | null
    orgId: string | null
    ambiguous: boolean
    activeTeamName?: string
    activeOrgName?: string
}

interface ApiKeyInfo {
    scoped_teams?: (string | number)[]
    scoped_organizations?: string[]
}

interface UserInfo {
    team?: { id?: number | string; name?: string }
    organization?: { id?: string; name?: string }
}

interface OrgProjectsList {
    results?: { id: number | string; name?: string }[]
}

export async function autoDiscover(host: string, accessToken: string): Promise<Discovered> {
    const base = host.replace(/\/$/, '')
    const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }

    const [keyInfo, user] = await Promise.all([
        json<ApiKeyInfo>(`${base}/api/personal_api_keys/@current`, headers),
        json<UserInfo>(`${base}/api/users/@me/`, headers),
    ])

    const scopedTeams = keyInfo?.scoped_teams ?? []
    const scopedOrgs = keyInfo?.scoped_organizations ?? []

    if (scopedTeams.length === 1) {
        return {
            projectId: String(scopedTeams[0]),
            orgId: user?.organization?.id ?? null,
            ambiguous: false,
            activeTeamName: user?.team?.name,
            activeOrgName: user?.organization?.name,
        }
    }

    if (scopedTeams.length > 1) {
        return {
            projectId: null,
            orgId: user?.organization?.id ?? null,
            ambiguous: true,
            activeTeamName: user?.team?.name,
            activeOrgName: user?.organization?.name,
        }
    }

    const activeOrgId = user?.organization?.id
    const activeTeamId = user?.team?.id != null ? String(user.team.id) : null

    if (scopedOrgs.length === 0 || (activeOrgId && scopedOrgs.includes(activeOrgId))) {
        return {
            projectId: activeTeamId,
            orgId: activeOrgId ?? null,
            ambiguous: false,
            activeTeamName: user?.team?.name,
            activeOrgName: user?.organization?.name,
        }
    }

    const orgId = scopedOrgs[0]!
    const projects = await json<OrgProjectsList>(
        `${base}/api/organizations/${encodeURIComponent(orgId)}/projects/`,
        headers
    )
    const first = projects?.results?.[0]?.id
    return {
        projectId: first != null ? String(first) : null,
        orgId,
        ambiguous: false,
        activeTeamName: user?.team?.name,
        activeOrgName: user?.organization?.name,
    }
}

export async function listProjects(host: string, accessToken: string): Promise<
    Array<{ id: string; name: string; organizationId: string | null }>
> {
    const base = host.replace(/\/$/, '')
    const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
    const me = await json<UserInfo>(`${base}/api/users/@me/`, headers)
    const orgId = me?.organization?.id
    if (!orgId) return []
    const projects = await json<OrgProjectsList>(
        `${base}/api/organizations/${encodeURIComponent(orgId)}/projects/`,
        headers
    )
    return (projects?.results ?? []).map((p) => ({
        id: String(p.id),
        name: p.name ?? '(unnamed)',
        organizationId: orgId,
    }))
}

async function json<T>(url: string, headers: Record<string, string>): Promise<T | null> {
    try {
        const res = await fetch(url, { headers })
        if (!res.ok) return null
        return (await res.json()) as T
    } catch {
        return null
    }
}
