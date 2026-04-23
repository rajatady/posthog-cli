import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('undici', () => ({ fetch: vi.fn() }))

import { fetch } from 'undici'
import { autoDiscover, listProjects } from '../src/lib/discover.js'

const mockFetch = fetch as ReturnType<typeof vi.fn>

function jsonResponse(data: unknown, ok = true): unknown {
    return {
        ok,
        json: async () => data,
    }
}

const HOST = 'https://us.posthog.com'
const TOKEN = 'phx_test'

describe('autoDiscover', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('returns projectId from scoped_teams when exactly one team', async () => {
        mockFetch
            .mockResolvedValueOnce(jsonResponse({ scoped_teams: [42], scoped_organizations: [] }))
            .mockResolvedValueOnce(jsonResponse({ team: { id: 42, name: 'My Team' }, organization: { id: 'org-1', name: 'My Org' } }))

        const result = await autoDiscover(HOST, TOKEN)
        expect(result.projectId).toBe('42')
        expect(result.orgId).toBe('org-1')
        expect(result.ambiguous).toBe(false)
        expect(result.activeTeamName).toBe('My Team')
        expect(result.activeOrgName).toBe('My Org')
    })

    it('returns null orgId when user has no organization (single scoped team)', async () => {
        mockFetch
            .mockResolvedValueOnce(jsonResponse({ scoped_teams: [42], scoped_organizations: [] }))
            .mockResolvedValueOnce(jsonResponse({ team: { id: 42, name: 'My Team' } }))

        const result = await autoDiscover(HOST, TOKEN)
        expect(result.projectId).toBe('42')
        expect(result.orgId).toBeNull()
    })

    it('returns ambiguous when scoped_teams has multiple teams', async () => {
        mockFetch
            .mockResolvedValueOnce(jsonResponse({ scoped_teams: [1, 2, 3], scoped_organizations: [] }))
            .mockResolvedValueOnce(jsonResponse({ organization: { id: 'org-1' } }))

        const result = await autoDiscover(HOST, TOKEN)
        expect(result.projectId).toBeNull()
        expect(result.ambiguous).toBe(true)
    })

    it('includes team name and nulls orgId when user has team but no org (multiple scoped teams)', async () => {
        mockFetch
            .mockResolvedValueOnce(jsonResponse({ scoped_teams: [1, 2], scoped_organizations: [] }))
            .mockResolvedValueOnce(jsonResponse({ team: { id: 1, name: 'Primary' } }))

        const result = await autoDiscover(HOST, TOKEN)
        expect(result.ambiguous).toBe(true)
        expect(result.activeTeamName).toBe('Primary')
        expect(result.orgId).toBeNull()
    })

    it('uses active team when no scoped_teams and active org matches', async () => {
        mockFetch
            .mockResolvedValueOnce(jsonResponse({ scoped_teams: [], scoped_organizations: ['org-1'] }))
            .mockResolvedValueOnce(jsonResponse({ team: { id: 99, name: 'Active' }, organization: { id: 'org-1', name: 'Org 1' } }))

        const result = await autoDiscover(HOST, TOKEN)
        expect(result.projectId).toBe('99')
        expect(result.orgId).toBe('org-1')
        expect(result.ambiguous).toBe(false)
    })

    it('uses active team when scoped_organizations is empty', async () => {
        mockFetch
            .mockResolvedValueOnce(jsonResponse({ scoped_teams: [], scoped_organizations: [] }))
            .mockResolvedValueOnce(jsonResponse({ team: { id: 55 }, organization: { id: 'org-2' } }))

        const result = await autoDiscover(HOST, TOKEN)
        expect(result.projectId).toBe('55')
    })

    it('fetches org projects when scoped org does not match active org', async () => {
        mockFetch
            .mockResolvedValueOnce(jsonResponse({ scoped_teams: [], scoped_organizations: ['org-other'] }))
            .mockResolvedValueOnce(jsonResponse({ team: { id: 1 }, organization: { id: 'org-active' } }))
            .mockResolvedValueOnce(jsonResponse({ results: [{ id: 777, name: 'First Project' }] }))

        const result = await autoDiscover(HOST, TOKEN)
        expect(result.projectId).toBe('777')
        expect(result.orgId).toBe('org-other')
        expect(mockFetch).toHaveBeenCalledTimes(3)
        expect((mockFetch.mock.calls[2] as unknown[])[0]).toContain('org-other')
    })

    it('returns null projectId when org projects list is empty', async () => {
        mockFetch
            .mockResolvedValueOnce(jsonResponse({ scoped_teams: [], scoped_organizations: ['org-x'] }))
            .mockResolvedValueOnce(jsonResponse({ team: { id: 1 }, organization: { id: 'org-y' } }))
            .mockResolvedValueOnce(jsonResponse({ results: [] }))

        const result = await autoDiscover(HOST, TOKEN)
        expect(result.projectId).toBeNull()
    })

    it('returns null gracefully when API calls fail', async () => {
        mockFetch.mockResolvedValue({ ok: false, json: async () => null })

        const result = await autoDiscover(HOST, TOKEN)
        expect(result.projectId).toBeNull()
        expect(result.ambiguous).toBe(false)
    })

    it('returns null gracefully when fetch throws', async () => {
        mockFetch.mockRejectedValue(new Error('connection refused'))

        const result = await autoDiscover(HOST, TOKEN)
        expect(result.projectId).toBeNull()
        expect(result.ambiguous).toBe(false)
    })

    it('trims trailing slash from host', async () => {
        mockFetch
            .mockResolvedValueOnce(jsonResponse({ scoped_teams: [], scoped_organizations: [] }))
            .mockResolvedValueOnce(jsonResponse({ team: { id: 1 }, organization: { id: 'o' } }))

        await autoDiscover('https://us.posthog.com/', TOKEN)
        const url = mockFetch.mock.calls[0][0] as string
        expect(url).not.toMatch(/posthog\.com\/\//)
    })
})

describe('listProjects', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('returns empty array when user has no organization', async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ team: {}, organization: undefined }))
        const result = await listProjects(HOST, TOKEN)
        expect(result).toEqual([])
    })

    it('returns projects mapped with id, name, organizationId', async () => {
        mockFetch
            .mockResolvedValueOnce(jsonResponse({ organization: { id: 'org-1' } }))
            .mockResolvedValueOnce(jsonResponse({
                results: [
                    { id: 1, name: 'Prod' },
                    { id: 2, name: 'Staging' },
                ],
            }))

        const result = await listProjects(HOST, TOKEN)
        expect(result).toHaveLength(2)
        expect(result[0]).toEqual({ id: '1', name: 'Prod', organizationId: 'org-1' })
        expect(result[1]).toEqual({ id: '2', name: 'Staging', organizationId: 'org-1' })
    })

    it('uses (unnamed) fallback for projects without a name', async () => {
        mockFetch
            .mockResolvedValueOnce(jsonResponse({ organization: { id: 'org-1' } }))
            .mockResolvedValueOnce(jsonResponse({ results: [{ id: 3 }] }))

        const result = await listProjects(HOST, TOKEN)
        expect(result[0]?.name).toBe('(unnamed)')
    })

    it('returns empty array when project results are absent', async () => {
        mockFetch
            .mockResolvedValueOnce(jsonResponse({ organization: { id: 'org-1' } }))
            .mockResolvedValueOnce(jsonResponse({}))

        const result = await listProjects(HOST, TOKEN)
        expect(result).toEqual([])
    })
})
