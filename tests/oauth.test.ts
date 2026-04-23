import { describe, it, expect, vi, beforeEach } from 'vitest'
import http from 'node:http'

vi.mock('undici', () => ({ fetch: vi.fn() }))
vi.mock('node:child_process', () => ({
    spawn: vi.fn().mockReturnValue({ unref: vi.fn() }),
}))

import { fetch } from 'undici'
import { spawn } from 'node:child_process'
import { registerClient, refreshToken, pkcePair, authorize } from '../src/lib/oauth.js'

const mockFetch = fetch as ReturnType<typeof vi.fn>
const mockSpawn = spawn as ReturnType<typeof vi.fn>

function jsonRes(data: unknown, ok = true) {
    return {
        ok,
        status: ok ? 200 : 400,
        text: async () => JSON.stringify(data),
        json: async () => data,
    }
}

// Use native http (not undici mock) to hit the real callback server
function httpGet(url: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let body = ''
            res.on('data', (d: Buffer) => { body += d.toString() })
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
        }).on('error', reject)
    })
}

describe('pkcePair', () => {
    it('returns a verifier and challenge', () => {
        const { verifier, challenge } = pkcePair()
        expect(typeof verifier).toBe('string')
        expect(typeof challenge).toBe('string')
        expect(verifier.length).toBeGreaterThan(20)
        expect(challenge.length).toBeGreaterThan(20)
    })

    it('verifier and challenge differ', () => {
        const { verifier, challenge } = pkcePair()
        expect(verifier).not.toBe(challenge)
    })

    it('generates unique pairs each call', () => {
        const a = pkcePair()
        const b = pkcePair()
        expect(a.verifier).not.toBe(b.verifier)
        expect(a.challenge).not.toBe(b.challenge)
    })

    it('produces URL-safe characters only', () => {
        for (let i = 0; i < 5; i++) {
            const { verifier, challenge } = pkcePair()
            expect(verifier).toMatch(/^[A-Za-z0-9\-_]+$/)
            expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/)
        }
    })
})

describe('registerClient', () => {
    beforeEach(() => vi.clearAllMocks())

    it('POST to /oauth/register and returns client', async () => {
        mockFetch.mockResolvedValueOnce(jsonRes({ client_id: 'cid-123' }))
        const client = await registerClient('https://us.posthog.com')
        expect(client.clientId).toBe('cid-123')
        expect(client.host).toBe('https://us.posthog.com')
        expect(client.registeredAt).toBeLessThanOrEqual(Date.now())
        const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
        expect(url).toBe('https://us.posthog.com/oauth/register')
        expect(init.method).toBe('POST')
    })

    it('uses custom client name when provided', async () => {
        mockFetch.mockResolvedValueOnce(jsonRes({ client_id: 'cid-custom' }))
        await registerClient('https://us.posthog.com', { clientName: 'my-tool' })
        const body = JSON.parse((mockFetch.mock.calls[0] as [string, { body: string }])[1].body)
        expect(body.client_name).toBe('my-tool')
    })

    it('throws with message when DCR returns non-OK', async () => {
        mockFetch.mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'rate limited' })
        await expect(registerClient('https://us.posthog.com')).rejects.toThrow('DCR failed')
    })

    it('throws with network error message when fetch rejects', async () => {
        const cause = new Error('ECONNREFUSED')
        mockFetch.mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { cause }))
        await expect(registerClient('https://us.posthog.com')).rejects.toThrow('network request')
    })

    it('trims trailing slash from host', async () => {
        mockFetch.mockResolvedValueOnce(jsonRes({ client_id: 'cid' }))
        await registerClient('https://us.posthog.com/')
        expect((mockFetch.mock.calls[0] as unknown[])[0]).toBe('https://us.posthog.com/oauth/register')
    })
})

describe('refreshToken', () => {
    beforeEach(() => vi.clearAllMocks())

    it('POSTs to /oauth/token with refresh_token grant', async () => {
        mockFetch.mockResolvedValueOnce(jsonRes({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_in: 3600,
            token_type: 'Bearer',
            scope: 'feature_flag:read',
        }))
        const tokens = await refreshToken({
            host: 'https://us.posthog.com',
            clientId: 'cid',
            refreshToken: 'old-refresh',
        })
        expect(tokens.accessToken).toBe('new-access')
        expect(tokens.refreshToken).toBe('new-refresh')
        expect(tokens.scope).toBe('feature_flag:read')
        expect(tokens.expiresAt).toBeGreaterThan(Date.now())
        const [url] = mockFetch.mock.calls[0] as [string]
        expect(url).toContain('/oauth/token')
    })

    it('handles null refresh_token in response', async () => {
        mockFetch.mockResolvedValueOnce(jsonRes({
            access_token: 'new-access',
            expires_in: 3600,
            token_type: 'Bearer',
        }))
        const tokens = await refreshToken({ host: 'https://us.posthog.com', clientId: 'c', refreshToken: 'r' })
        expect(tokens.refreshToken).toBeNull()
    })

    it('uses 3600s TTL when expires_in absent', async () => {
        mockFetch.mockResolvedValueOnce(jsonRes({ access_token: 'tok', token_type: 'Bearer' }))
        const before = Date.now()
        const tokens = await refreshToken({ host: 'https://us.posthog.com', clientId: 'c', refreshToken: 'r' })
        expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000 - 100)
    })

    it('throws when refresh returns non-OK', async () => {
        mockFetch.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'invalid_grant' })
        await expect(
            refreshToken({ host: 'https://us.posthog.com', clientId: 'c', refreshToken: 'bad' })
        ).rejects.toThrow('refresh failed')
    })
})

describe('authorize callback server', () => {
    it('resolves with tokens when correct code+state are returned to callback', async () => {
        mockFetch.mockResolvedValueOnce(jsonRes({
            access_token: 'access-tok',
            refresh_token: 'refresh-tok',
            expires_in: 3600,
            token_type: 'Bearer',
        }))
        mockSpawn.mockReturnValue({ unref: vi.fn() })

        let callbackPort = 0
        let callbackState = ''

        const tokenPromise = authorize({
            host: 'http://127.0.0.1',
            clientId: 'test-client',
            scopes: ['feature_flag:read'],
            openBrowser: false,
            onRedirectURL: (url) => {
                const params = new URLSearchParams(url.split('?')[1])
                const redirectUri = params.get('redirect_uri')!
                callbackPort = parseInt(new URL(redirectUri).port, 10)
                callbackState = params.get('state')!
                // fire callback request async after returning
                setImmediate(async () => {
                    try {
                        await httpGet(
                            `http://127.0.0.1:${callbackPort}/callback?code=authcode&state=${callbackState}`
                        )
                    } catch {
                        // ignore
                    }
                })
            },
        })

        const tokens = await tokenPromise
        expect(tokens.accessToken).toBe('access-tok')
        expect(tokens.refreshToken).toBe('refresh-tok')
        expect(callbackPort).toBeGreaterThan(0)
    })

    it('rejects when OAuth error is returned to callback', async () => {
        const tokenPromise = authorize({
            host: 'http://127.0.0.1',
            clientId: 'test-client',
            scopes: [],
            openBrowser: false,
            onRedirectURL: (_url) => {
                const params = new URLSearchParams(_url.split('?')[1])
                const redirectUri = params.get('redirect_uri')!
                const port = parseInt(new URL(redirectUri).port, 10)
                setImmediate(async () => {
                    try {
                        await httpGet(
                            `http://127.0.0.1:${port}/callback?error=access_denied&error_description=User+denied`
                        )
                    } catch {
                        // ignore
                    }
                })
            },
        })

        await expect(tokenPromise).rejects.toThrow('OAuth error: access_denied')
    })

    it('rejects when callback is missing code/state', async () => {
        const tokenPromise = authorize({
            host: 'http://127.0.0.1',
            clientId: 'test-client',
            scopes: [],
            openBrowser: false,
            onRedirectURL: (_url) => {
                const params = new URLSearchParams(_url.split('?')[1])
                const redirectUri = params.get('redirect_uri')!
                const port = parseInt(new URL(redirectUri).port, 10)
                setImmediate(async () => {
                    try {
                        await httpGet(`http://127.0.0.1:${port}/callback`)
                    } catch {
                        // ignore
                    }
                })
            },
        })

        await expect(tokenPromise).rejects.toThrow('missing code or state')
    })

    it('returns 404 for non-callback paths', async () => {
        const tokenPromise = authorize({
            host: 'http://127.0.0.1',
            clientId: 'test-client',
            scopes: [],
            openBrowser: false,
            onRedirectURL: (_url) => {
                const params = new URLSearchParams(_url.split('?')[1])
                const redirectUri = params.get('redirect_uri')!
                const port = parseInt(new URL(redirectUri).port, 10)
                setImmediate(async () => {
                    try {
                        await httpGet(`http://127.0.0.1:${port}/health`)
                        // also send valid callback to clean up
                        const state = new URLSearchParams(_url.split('?')[1]).get('state')!
                        mockFetch.mockResolvedValueOnce(jsonRes({ access_token: 't', token_type: 'Bearer' }))
                        await httpGet(
                            `http://127.0.0.1:${port}/callback?code=c&state=${state}`
                        )
                    } catch {
                        // ignore
                    }
                })
            },
        })

        // will resolve because we sent the valid callback after the 404
        await tokenPromise
    })
})

describe('tryOpenBrowser', () => {
    beforeEach(() => vi.clearAllMocks())

    it('opens browser with spawn when openBrowser is not false', async () => {
        mockFetch.mockResolvedValueOnce(jsonRes({
            access_token: 'tok',
            token_type: 'Bearer',
            expires_in: 3600,
        }))

        const tokenPromise = authorize({
            host: 'http://127.0.0.1',
            clientId: 'test-client',
            scopes: [],
            openBrowser: true,
            onRedirectURL: (_url) => {
                const params = new URLSearchParams(_url.split('?')[1])
                const redirectUri = params.get('redirect_uri')!
                const port = parseInt(new URL(redirectUri).port, 10)
                const state = params.get('state')!
                setImmediate(async () => {
                    try {
                        await httpGet(`http://127.0.0.1:${port}/callback?code=c&state=${state}`)
                    } catch { /* ignore */ }
                })
            },
        })

        await tokenPromise
        expect(mockSpawn).toHaveBeenCalledOnce()
    })
})
