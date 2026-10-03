// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {createServer, type IncomingHttpHeaders, type Server} from 'node:http'
import type {AddressInfo} from 'node:net'
import pino from 'pino'
import {ApiClient} from '../../src/runtime/api-client/api-client.js'
import {noopIdempotency} from '../../src/adapters/idempotency/strategies/noop-idempotency.strategy.js'
import {noopCircuitBreaker} from '../../src/adapters/resilience/strategies/noop-circuit-breaker.strategy.js'
import type {ExecuteRequestContext} from '../../src/spi/connector/connector-api.js'

interface Seen {
    method: string;
    url: string;
    headers: IncomingHttpHeaders
}

/** A real HTTP listener, so what is asserted is what axios actually put on the wire. */
async function listen(reply: (req: Seen) => { status: number; delayMs?: number } = () => ({status: 200})) {
    const seen: Seen[] = []
    const server: Server = createServer((req, res) => {
        const entry = {method: req.method ?? '', url: req.url ?? '', headers: req.headers}
        seen.push(entry)
        const {status, delayMs} = reply(entry)
        req.resume()
        setTimeout(() => {
            if (res.destroyed) return
            res.writeHead(status, {'content-type': 'application/json'}).end(JSON.stringify({ok: status < 400}))
        }, delayMs ?? 0)
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const {port} = server.address() as AddressInfo
    return {
        seen, port, close: () => new Promise<void>(r => {
            server.closeAllConnections();
            server.close(() => r())
        })
    }
}

function client(port: number, overrides: { maxRetries?: number; requestTimeoutMs?: number } = {}) {
    return new ApiClient(
        `http://127.0.0.1:${port}/api/v1`,
        {
            protocol: 'http',
            host: '127.0.0.1',
            port,
            basePath: '/api/v1',
            requestTimeoutMs: overrides.requestTimeoutMs ?? 2000,
            maxRetries: overrides.maxRetries ?? 0
        },
        noopCircuitBreaker(), noopIdempotency(), pino({level: 'silent'}),
        {serviceName: 'svc', agentName: 'agent', serverId: 'harbor-test'}
    )
}

const ctx: ExecuteRequestContext = {
    tokenPayload: {
        access_token: 'USER-SECRET-TOKEN',
        token_type: 'bearer',
        expires_in: 60,
        refresh_token: '',
        scope: ''
    },
    invalidate: async () => {
    },
    idempotencyKey: 'idem-1', idempotencyKeyTtlMs: 1000, correlationId: 'exec-1'
}

describe('ApiClient — the outbound call stays on the service', () => {
    let service: Awaited<ReturnType<typeof listen>>
    let elsewhere: Awaited<ReturnType<typeof listen>>
    beforeAll(async () => {
        service = await listen();
        elsewhere = await listen()
    })
    afterAll(async () => {
        await service.close();
        await elsewhere.close()
    })
    beforeEach(() => {
        service.seen.length = 0;
        elsewhere.seen.length = 0
    })

    it.each([
        (p: number) => `http://127.0.0.1:${p}/steal`,
        (p: number) => `//127.0.0.1:${p}/steal`
    ])('an absolute path never reaches another host, and the bearer never leaves the service', async toPath => {
        await client(service.port).executeRequest({
            method: 'GET',
            path: toPath(elsewhere.port)
        }, ctx).catch(() => undefined)
        expect(elsewhere.seen).toHaveLength(0)
        for (const r of service.seen) expect(r.url.startsWith('/api/v1/')).toBe(true)
    })

    it('joins a relative path onto the base path', async () => {
        await client(service.port).executeRequest({method: 'GET', path: '/orders/1'}, ctx)
        expect(service.seen[0]).toMatchObject({method: 'GET', url: '/api/v1/orders/1'})
        expect(service.seen[0]?.headers['authorization']).toBe('Bearer USER-SECRET-TOKEN')
    })
})

describe('ApiClient — headers the program may and may not set', () => {
    let service: Awaited<ReturnType<typeof listen>>
    beforeAll(async () => {
        service = await listen()
    })
    afterAll(async () => {
        await service.close()
    })
    beforeEach(() => {
        service.seen.length = 0
    })

    it('drops identity, Harbor-owned and routing headers in any letter case; Harbor\'s own values stand', async () => {
        await client(service.port).executeRequest({
            method: 'POST', path: '/orders', body: {a: 1},
            headers: {
                Authorization: 'Bearer SOMEONE-ELSE', 'x-idempotency-key': 'forged', 'X-MCP-Session-ID': 'forged',
                'x-mcp-service': 'forged', 'X-Request-Source': 'forged', 'x-correlation-id': 'forged',
                Host: 'evil.example', Cookie: 'session=stolen', 'X-HTTP-Method-Override': 'DELETE',
                'X-Original-URL': '/admin', 'X-Forwarded-Host': 'evil.example', 'Transfer-Encoding': 'chunked'
            }
        }, ctx)
        const h = service.seen[0]!.headers
        expect(h['authorization']).toBe('Bearer USER-SECRET-TOKEN')
        expect(h['x-idempotency-key']).toBe('idem-1')
        // MCP 2026-07-28 has no sessions: Harbor sends no session header, and the name stays reserved — the program's copy is dropped.
        expect(h['x-mcp-session-id']).toBeUndefined()
        expect(h['x-mcp-service']).toBe('svc')
        expect(h['x-request-source']).toBe('agent')
        expect(h['x-correlation-id']).toBe('exec-1')
        expect(h['host']).toBe(`127.0.0.1:${service.port}`)
        for (const dropped of ['cookie', 'x-http-method-override', 'x-original-url', 'x-forwarded-host']) expect(h[dropped], dropped).toBeUndefined()
        expect(h['transfer-encoding']).toBeUndefined()
        expect(service.seen[0]!.method).toBe('POST')
    })

    it('passes ordinary headers through, including a Content-Type override', async () => {
        await client(service.port).executeRequest({
            method: 'POST', path: '/orders', body: {a: 1},
            headers: {Accept: 'application/xml', 'X-Tenant': 't-1', 'content-type': 'application/merge-patch+json'}
        }, ctx)
        const h = service.seen[0]!.headers
        expect(h['accept']).toBe('application/xml')
        expect(h['x-tenant']).toBe('t-1')
        expect(h['content-type']).toBe('application/merge-patch+json')
    })
})

describe('ApiClient — retries never repeat a call whose effect may already have happened', () => {
    it.each([
        ['POST', 500], ['PATCH', 503], ['POST', 'timeout'], ['PATCH', 'timeout']
    ] as const)('%s after %s is sent exactly once and fails with the outcome unknown', async (method, failure) => {
        const backend = await listen(() => failure === 'timeout' ? {status: 201, delayMs: 400} : {status: failure})
        try {
            await expect(client(backend.port, {maxRetries: 2, requestTimeoutMs: 150}).executeRequest({
                method,
                path: '/orders',
                body: {a: 1}
            }, ctx)).rejects.toThrow()
            expect(backend.seen).toHaveLength(1)
        } finally {
            await backend.close()
        }
    })

    it.each([['GET', 500], ['PUT', 'timeout'], ['DELETE', 502]] as const)('%s after %s is retried up to maxRetries', async (method, failure) => {
        const backend = await listen(() => failure === 'timeout' ? {status: 200, delayMs: 400} : {status: failure})
        try {
            await expect(client(backend.port, {maxRetries: 1, requestTimeoutMs: 150}).executeRequest({
                method,
                path: '/orders/1'
            }, ctx)).rejects.toThrow()
            expect(backend.seen).toHaveLength(2)
        } finally {
            await backend.close()
        }
    }, 10_000)
})

describe('ApiClient — circuit-breaker bookkeeping', () => {
    it('records one failure per logical call, under the endpoint key the bridge passed', async () => {
        const backend = await listen(() => ({status: 500}))
        const failures: string[] = []
        const breaker = {
            ...noopCircuitBreaker(), recordFailure: (k: string) => {
                failures.push(k)
            }
        }
        const c = new ApiClient(
            `http://127.0.0.1:${backend.port}`,
            {
                protocol: 'http',
                host: '127.0.0.1',
                port: backend.port,
                basePath: '',
                requestTimeoutMs: 1000,
                maxRetries: 1
            },
            breaker, noopIdempotency(), pino({level: 'silent'}), {serviceName: 'svc', agentName: 'agent'}
        )
        try {
            await expect(c.executeRequest({method: 'GET', path: '/orders/abc'}, {
                ...ctx,
                endpoint: '/orders/{orderId}'
            })).rejects.toThrow()
            expect(backend.seen).toHaveLength(2) // one retry
            expect(failures).toEqual(['/orders/{orderId}']) // one failure, on the template key
            await expect(c.executeRequest({method: 'POST', path: '/orders/123'}, ctx)).rejects.toThrow()
            expect(failures[1]).toBe('/orders/{id}') // no key passed ⇒ derived from the path
        } finally {
            await backend.close()
        }
    }, 10_000)
})
