import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('undici', () => ({ fetch: vi.fn() }))
vi.mock('../src/lib/config.js', () => ({
    saveConfig: vi.fn(),
    loadConfig: vi.fn(),
}))

import { fetch } from 'undici'
import { saveConfig } from '../src/lib/config.js'
import {
    resolveRequest,
    executeRequest,
    toKebab,
    fromKebab,
    redactHeaders,
} from '../src/lib/api.js'
import type { ResolvedRequest } from '../src/lib/api.js'
import type { HttpSpec } from '../src/lib/registry.js'

const mockFetch = fetch as ReturnType<typeof vi.fn>
const mockSaveConfig = saveConfig as ReturnType<typeof vi.fn>

const baseConfig = {
    host: 'https://us.posthog.com',
    apiKey: 'phx_testkey',
    refreshToken: null,
    clientId: null,
    expiresAt: null,
    projectId: null,
    orgId: null,
}

const minimalSpec: HttpSpec = {
    method: 'GET',
    path: '/api/projects/{project_id}/feature_flags/',
    pathParams: [],
    queryParams: [],
    bodyParams: [],
}

describe('resolveRequest', () => {
    it('throws when apiKey is missing', () => {
        expect(() =>
            resolveRequest({ ...baseConfig, apiKey: null }, minimalSpec, {})
        ).toThrow('Missing API key')
    })

    it('substitutes @current for {project_id} when no projectId in config', () => {
        const req = resolveRequest({ ...baseConfig, projectId: null }, minimalSpec, {})
        expect(req.url).toContain('%40current')
    })

    it('substitutes cfg.projectId for {project_id} when set', () => {
        const req = resolveRequest({ ...baseConfig, projectId: '99' }, minimalSpec, {})
        expect(req.url).toContain('/99/')
    })

    it('substitutes @current for {organization_id} when no orgId', () => {
        const spec: HttpSpec = {
            ...minimalSpec,
            path: '/api/organizations/{organization_id}/projects/',
        }
        const req = resolveRequest({ ...baseConfig, orgId: null }, spec, {})
        expect(req.url).toContain('%40current')
    })

    it('substitutes cfg.orgId for {organization_id} when set', () => {
        const spec: HttpSpec = {
            ...minimalSpec,
            path: '/api/organizations/{organization_id}/projects/',
        }
        const req = resolveRequest({ ...baseConfig, orgId: 'org-abc' }, spec, {})
        expect(req.url).toContain('/org-abc/')
    })

    it('throws on missing required path param', () => {
        const spec: HttpSpec = {
            ...minimalSpec,
            path: '/api/feature_flags/{id}/',
            pathParams: ['id'],
        }
        expect(() => resolveRequest(baseConfig, spec, {})).toThrow(
            'Missing required path parameter: --id'
        )
    })

    it('substitutes provided path param', () => {
        const spec: HttpSpec = {
            ...minimalSpec,
            path: '/api/feature_flags/{id}/',
            pathParams: ['id'],
        }
        const req = resolveRequest(baseConfig, spec, { id: '42' })
        expect(req.url).toContain('/42/')
    })

    it('appends query params as URLSearchParams', () => {
        const spec: HttpSpec = { ...minimalSpec, queryParams: ['limit', 'search'] }
        const req = resolveRequest(baseConfig, spec, { limit: 10, search: 'test flag' })
        expect(req.url).toContain('limit=10')
        expect(req.url).toContain('search=test+flag')
    })

    it('handles array query params', () => {
        const spec: HttpSpec = { ...minimalSpec, queryParams: ['tags'] }
        const req = resolveRequest(baseConfig, spec, { tags: ['a', 'b'] })
        expect(req.url).toContain('tags=a')
        expect(req.url).toContain('tags=b')
    })

    it('skips null/undefined query params', () => {
        const spec: HttpSpec = { ...minimalSpec, queryParams: ['limit'] }
        const req = resolveRequest(baseConfig, spec, { limit: null })
        expect(req.url).not.toContain('limit=')
    })

    it('builds body for POST requests', () => {
        const spec: HttpSpec = {
            method: 'POST',
            path: '/api/projects/{project_id}/feature_flags/',
            pathParams: [],
            queryParams: [],
            bodyParams: ['name', 'key'],
        }
        const req = resolveRequest(baseConfig, spec, { name: 'My Flag', key: 'my-flag' })
        expect(req.body).toEqual({ name: 'My Flag', key: 'my-flag' })
        expect(req.headers['Content-Type']).toBe('application/json')
    })

    it('does not build body for GET requests', () => {
        const spec: HttpSpec = { ...minimalSpec, bodyParams: ['name'] }
        const req = resolveRequest(baseConfig, spec, { name: 'ignored' })
        expect(req.body).toBeNull()
        expect(req.headers['Content-Type']).toBeUndefined()
    })

    it('does not build body for DELETE requests', () => {
        const spec: HttpSpec = { ...minimalSpec, method: 'DELETE', bodyParams: ['confirm'] }
        const req = resolveRequest(baseConfig, spec, { confirm: true })
        expect(req.body).toBeNull()
    })

    it('sets Authorization, Accept, and User-Agent headers', () => {
        const req = resolveRequest(baseConfig, minimalSpec, {})
        expect(req.headers.Authorization).toBe('Bearer phx_testkey')
        expect(req.headers.Accept).toBe('application/json')
        expect(req.headers['User-Agent']).toMatch(/^thehogcli\//)
    })

    it('trims trailing slash from host', () => {
        const req = resolveRequest({ ...baseConfig, host: 'https://us.posthog.com/' }, minimalSpec, {})
        expect(req.url).not.toContain('posthog.com//')
    })
})

describe('executeRequest', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    function makeReq(): ResolvedRequest {
        return {
            method: 'GET',
            url: 'https://us.posthog.com/api/projects/%40current/feature_flags/',
            headers: { Authorization: 'Bearer phx_test', Accept: 'application/json', 'User-Agent': 'thehogcli/test' },
            body: null,
        }
    }

    it('returns parsed JSON body on 200', async () => {
        mockFetch.mockResolvedValueOnce({
            status: 200,
            text: async () => JSON.stringify({ results: [] }),
        })
        const result = await executeRequest(makeReq())
        expect(result.status).toBe(200)
        expect(result.body).toEqual({ results: [] })
        expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('returns raw string when response is not JSON', async () => {
        mockFetch.mockResolvedValueOnce({
            status: 200,
            text: async () => 'plain text response',
        })
        const result = await executeRequest(makeReq())
        expect(result.body).toBe('plain text response')
    })

    it('returns empty string body when response has no text', async () => {
        mockFetch.mockResolvedValueOnce({
            status: 204,
            text: async () => '',
        })
        const result = await executeRequest(makeReq())
        expect(result.body).toBe('')
        expect(result.status).toBe(204)
    })

    it('serializes non-null request body as JSON for POST', async () => {
        mockFetch.mockResolvedValueOnce({
            status: 201,
            text: async () => JSON.stringify({ id: 1 }),
        })
        const req: ResolvedRequest = {
            method: 'POST',
            url: 'https://us.posthog.com/api/projects/%40current/feature_flags/',
            headers: { Authorization: 'Bearer phx_test', Accept: 'application/json', 'User-Agent': 'thehogcli/test', 'Content-Type': 'application/json' },
            body: { name: 'My Flag', key: 'my-flag' },
        }
        const result = await executeRequest(req)
        expect(result.status).toBe(201)
        const [, init] = mockFetch.mock.calls[0] as [string, { body: string }]
        expect(init.body).toBe('{"name":"My Flag","key":"my-flag"}')
    })

    it('auto-refreshes on 401 when refreshToken + clientId present', async () => {
        mockFetch
            .mockResolvedValueOnce({ status: 401, text: async () => 'Unauthorized' })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    access_token: 'new-token',
                    expires_in: 3600,
                    token_type: 'Bearer',
                }),
                text: async () => JSON.stringify({ access_token: 'new-token' }),
            })
            .mockResolvedValueOnce({ status: 200, text: async () => '{"ok":true}' })

        const cfg = {
            ...baseConfig,
            refreshToken: 'rtoken',
            clientId: 'cid',
        }
        const result = await executeRequest(makeReq(), cfg)
        expect(result.status).toBe(200)
        expect(mockFetch).toHaveBeenCalledTimes(3)
    })

    it('does not retry on 401 when no refreshToken', async () => {
        mockFetch.mockResolvedValueOnce({ status: 401, text: async () => 'Unauthorized' })
        const result = await executeRequest(makeReq(), baseConfig)
        expect(result.status).toBe(401)
        expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('skips retry when refresh itself fails', async () => {
        mockFetch
            .mockResolvedValueOnce({ status: 401, text: async () => 'Unauthorized' })
            .mockRejectedValueOnce(new Error('network error'))

        const cfg = { ...baseConfig, refreshToken: 'rtoken', clientId: 'cid' }
        const result = await executeRequest(makeReq(), cfg)
        expect(result.status).toBe(401)
    })
})

describe('toKebab / fromKebab', () => {
    it('converts snake_case to kebab-case', () => {
        expect(toKebab('project_id')).toBe('project-id')
        expect(toKebab('group_type_index')).toBe('group-type-index')
    })

    it('converts kebab-case back to snake_case', () => {
        expect(fromKebab('project-id')).toBe('project_id')
        expect(fromKebab('group-type-index')).toBe('group_type_index')
    })

    it('is identity for already-correct forms', () => {
        expect(toKebab('limit')).toBe('limit')
        expect(fromKebab('limit')).toBe('limit')
    })
})

describe('redactHeaders', () => {
    it('replaces Authorization header with Bearer <redacted>', () => {
        const h = {
            Authorization: 'Bearer phx_secret',
            Accept: 'application/json',
        }
        const redacted = redactHeaders(h)
        expect(redacted.Authorization).toBe('Bearer <redacted>')
        expect(redacted.Accept).toBe('application/json')
    })

    it('does not mutate the original headers', () => {
        const h = { Authorization: 'Bearer phx_secret' }
        redactHeaders(h)
        expect(h.Authorization).toBe('Bearer phx_secret')
    })

    it('passes through headers without Authorization unchanged', () => {
        const h = { Accept: 'application/json', 'Content-Type': 'text/plain' }
        expect(redactHeaders(h)).toEqual(h)
    })
})
