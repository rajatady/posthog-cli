import { Agent, setGlobalDispatcher } from 'undici'

/**
 * Configure the process-wide undici dispatcher before any fetch() runs.
 *
 * Why this exists: Node 20+ defaults `autoSelectFamily: true` (happy-eyeballs).
 * When a host resolves to both IPv4 and IPv6 but the client has no IPv6 route,
 * IPv6 fails instantly with EHOSTUNREACH, and the happy-eyeballs race can bail
 * with an AggregateError before the slower IPv4 connects complete. Users see a
 * cryptic `fetch failed`.
 *
 * Forcing `family: 4` sidesteps the race entirely and costs nothing when IPv6
 * would have worked (TCP connect over IPv4 is not measurably slower for HTTPS).
 * Override with `THEHOGCLI_NET_FAMILY=0` (default dual-stack) or `=6` for IPv6
 * when running in IPv6-only environments.
 *
 * Also extends connect timeout from undici's default (10s) to 30s, helpful on
 * slow or constrained networks.
 */
export function configureNet(): void {
    const familyEnv = process.env.THEHOGCLI_NET_FAMILY
    const family: 0 | 4 | 6 =
        familyEnv === '0' ? 0 : familyEnv === '6' ? 6 : 4
    const connectTimeoutMs = Number.parseInt(process.env.THEHOGCLI_CONNECT_TIMEOUT_MS ?? '30000', 10)

    setGlobalDispatcher(
        new Agent({
            connect: {
                family,
                timeout: connectTimeoutMs,
            },
        })
    )
}
