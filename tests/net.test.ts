import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('undici', () => ({
    Agent: vi.fn().mockImplementation((opts: unknown) => ({ _opts: opts })),
    setGlobalDispatcher: vi.fn(),
    fetch: vi.fn(),
}))

import { Agent, setGlobalDispatcher } from 'undici'
import { configureNet } from '../src/lib/net.js'

const MockAgent = Agent as ReturnType<typeof vi.fn>
const mockSetGlobal = setGlobalDispatcher as ReturnType<typeof vi.fn>

function clearNetEnv(): void {
    delete process.env.THEHOGCLI_NET_FAMILY
    delete process.env.THEHOGCLI_CONNECT_TIMEOUT_MS
}

describe('configureNet', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        clearNetEnv()
    })

    afterEach(() => {
        clearNetEnv()
    })

    it('defaults to IPv4 (family: 4) and 30s timeout', () => {
        configureNet()
        expect(MockAgent).toHaveBeenCalledOnce()
        const opts = MockAgent.mock.calls[0][0] as { connect: { family: number; timeout: number } }
        expect(opts.connect.family).toBe(4)
        expect(opts.connect.timeout).toBe(30000)
        expect(mockSetGlobal).toHaveBeenCalledOnce()
    })

    it('uses dual-stack (family: 0) when THEHOGCLI_NET_FAMILY=0', () => {
        process.env.THEHOGCLI_NET_FAMILY = '0'
        configureNet()
        const opts = MockAgent.mock.calls[0][0] as { connect: { family: number } }
        expect(opts.connect.family).toBe(0)
    })

    it('uses IPv6 (family: 6) when THEHOGCLI_NET_FAMILY=6', () => {
        process.env.THEHOGCLI_NET_FAMILY = '6'
        configureNet()
        const opts = MockAgent.mock.calls[0][0] as { connect: { family: number } }
        expect(opts.connect.family).toBe(6)
    })

    it('uses IPv4 (family: 4) for unknown THEHOGCLI_NET_FAMILY values', () => {
        process.env.THEHOGCLI_NET_FAMILY = '99'
        configureNet()
        const opts = MockAgent.mock.calls[0][0] as { connect: { family: number } }
        expect(opts.connect.family).toBe(4)
    })

    it('respects custom THEHOGCLI_CONNECT_TIMEOUT_MS', () => {
        process.env.THEHOGCLI_CONNECT_TIMEOUT_MS = '5000'
        configureNet()
        const opts = MockAgent.mock.calls[0][0] as { connect: { timeout: number } }
        expect(opts.connect.timeout).toBe(5000)
    })

    it('sets the global dispatcher', () => {
        configureNet()
        expect(mockSetGlobal).toHaveBeenCalledOnce()
        const dispatcherArg = mockSetGlobal.mock.calls[0][0]
        expect(dispatcherArg).toBeDefined()
    })
})
