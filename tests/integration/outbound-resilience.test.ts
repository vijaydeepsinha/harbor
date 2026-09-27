// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * The governed api_execute handler over the real ApiClient and a real HTTP
 * listener: what the breaker and the idempotency layer do is judged by what
 * actually reached the backend.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ApiClient } from '../../src/runtime/api-client/api-client.js'
import { CountBasedCircuitBreakerStrategy } from '../../src/adapters/resilience/strategies/count-based-circuit-breaker.strategy.js'
import { noopIdempotency } from '../../src/spi/idempotency/strategies/noop-idempotency.strategy.js'
import type { CircuitBreakerStrategy } from '../../src/core/types/circuit-breaker.types.js'
import type { IdempotencyStrategy } from '../../src/core/types/idempotency.types.js'
import { ERR } from '../../src/core/constants.js'
import { makeResources, makeRuntime, registerGoverned, makeCtx, parseContent, silentLogger } from '../unit/code-mode-harness.js'

interface Seen { method: string; url: string; headers: IncomingHttpHeaders }

const closers: Array<() => Promise<void>> = []
afterEach(async () => { while (closers.length) await closers.pop()!() })

async function backend(status: (req: Seen) => number) {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    const entry = { method: req.method ?? '', url: req.url ?? '', headers: req.headers }
    seen.push(entry)
    req.resume()
    const code = status(entry)
    res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify({ id: `r-${seen.length}` }))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  closers.push(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()) }))
  return { seen, port: (server.address() as AddressInfo).port }
}

function governedTool(port: number, breaker: CircuitBreakerStrategy, idempotency: IdempotencyStrategy = noopIdempotency()) {
  const apiClient = new ApiClient(
    `http://127.0.0.1:${port}`,
    { protocol: 'http', host: '127.0.0.1', port, basePath: '', requestTimeoutMs: 1000, maxRetries: 0 },
    breaker, idempotency, silentLogger, { serviceName: 'trafficking', agentName: 'agent' }
  )
  const resources = { ...makeResources('trafficking', apiClient), circuitBreaker: breaker }
  return registerGoverned(makeRuntime(), resources)
}

describe('governed api_execute over the real ApiClient', () => {
  it('opens the breaker for a templated endpoint whatever the concrete id looks like', async () => {
    const { seen, port } = await backend(() => 500)
    const breaker = new CountBasedCircuitBreakerStrategy({ failureThreshold: 2, recoveryTimeMs: 60_000 })
    const tool = governedTool(port, breaker)
    // `abc` has no digit: the old failure key (/campaigns/abc/creatives) never matched the template key it was checked on.
    const program = `async () => (await api.request({ method: 'GET', path: '/campaigns/abc/creatives' })).status`
    for (let i = 0; i < 2; i++) parseContent(await tool({ service: 'trafficking', code: program }, makeCtx()))
    expect(seen).toHaveLength(2)
    const third = parseContent(await tool({ service: 'trafficking', code: program }, makeCtx())) as Record<string, unknown>
    expect(third['code']).toBe(ERR.CIRCUIT_OPEN)
    expect(seen).toHaveLength(2) // refused before the call went out
    expect(breaker.getState('/campaigns/{id}/creatives')).toBe('OPEN')
  })
})
