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
import { noopIdempotency } from '../../src/adapters/idempotency/strategies/noop-idempotency.strategy.js'
import { InMemoryIdempotencyStrategy } from '../../src/adapters/idempotency/strategies/in-memory-idempotency.strategy.js'
import { NoopCircuitBreakerStrategy } from '../../src/adapters/resilience/strategies/noop-circuit-breaker.strategy.js'
import type { CircuitBreakerStrategy } from '../../src/spi/resilience/circuit-breaker.js'
import type { IdempotencyStrategy } from '../../src/spi/idempotency/idempotency-strategy.js'
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

  it('keys idempotency by execution: two executions of the same program both reach the backend', async () => {
    const { seen, port } = await backend(() => 201)
    const idempotency = new InMemoryIdempotencyStrategy()
    const tool = governedTool(port, new NoopCircuitBreakerStrategy(), idempotency)
    const program = `async () => {
      const list = await api.request({ method: 'GET', path: '/campaigns' })
      const created = await api.request({ method: 'POST', path: '/campaigns', body: { name: 'Q4' } })
      return [list.status, created.data.id]
    }`
    const a = parseContent(await tool({ service: 'trafficking', code: program }, makeCtx()))
    const b = parseContent(await tool({ service: 'trafficking', code: program }, makeCtx()))
    idempotency.destroy()
    expect(seen.map(r => `${r.method} ${r.url}`)).toEqual(['GET /campaigns', 'POST /campaigns', 'GET /campaigns', 'POST /campaigns'])
    expect(a).not.toEqual(b) // the second create was not answered from the first one's cache
    const keys = seen.map(r => r.headers['x-idempotency-key'] as string)
    expect(new Set(keys).size).toBe(4)
    expect(keys[0]!.endsWith('-1') && keys[1]!.endsWith('-2')).toBe(true)
  })
})
