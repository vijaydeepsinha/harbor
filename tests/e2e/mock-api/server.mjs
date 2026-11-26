// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * Deterministic mock downstream API for the governance E2E suite.
 *
 * Zero dependencies (Node >= 22). It stands in for the "outside world" that
 * Harbor's sandbox programs call, and it is the only thing the E2E layer
 * mocks — Harbor, its rules, its store and its isolate are all real.
 *
 * Business surface (one OpenAPI operation each, see fixtures/services/*):
 *   GET    /ping                                   cheap allowed read
 *   GET    /customers/{customerId}                 READ
 *   GET    /customers/{customerId}/payment-details SENSITIVE
 *   GET    /orders/{orderId}                       READ (no governance rule → default decision)
 *   POST   /orders                                 WRITE  (high value ⇒ approval in the default rules)
 *   PATCH  /orders/{orderId}                       UPDATE
 *   DELETE /orders/{orderId}                       DELETE
 *   POST   /payments                               MULTI-STEP (approval in the default rules)
 *   POST   /notifications                          MULTI-STEP
 *   POST   /admin/users                            ADMIN  (denied in the default rules)
 *   GET    /admin/users                            ADMIN read
 *   POST   /unstable                               FAILURE: `mode` (body) or `status` (query) picks
 *                                                  200|400|401|403|404|409|429|500, or `timeout`
 *   ?delayMs=N on any endpoint delays the response deterministically (max 30 s).
 *
 * Every business endpoint requires a bearer that maps to an accepted test
 * identity (fixtures/identities.json); anything else is 401 — so "the wrong
 * identity reached the backend" is observable.
 *
 * Control plane (never authenticated, never governed):
 *   GET  /health                       liveness
 *   GET  /__admin/requests[?method=&path=]  every business request received since the last reset
 *   POST /__admin/reset                clears the log, state, counters; ends held `timeout` responses
 *   GET  /__admin/state                current orders / payments / notifications / users
 */
import http from 'node:http'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'

const PORT = Number(process.env['PORT'] ?? 4010)
const HOST = process.env['HOST'] ?? '0.0.0.0'
const IDENTITIES_FILE = process.env['IDENTITIES_FILE'] ?? new URL('../fixtures/identities.json', import.meta.url)
const MAX_DELAY_MS = 30_000
const TIMEOUT_HOLD_MS = 60_000

const identities = JSON.parse(readFileSync(IDENTITIES_FILE, 'utf8'))
/** bearer token → identity name (only accepted identities) */
const tokenToIdentity = new Map(
    identities.accepted.map((name) => [identities.tokens[name], name])
)

const CUSTOMERS = {
    'customer-001': {id: 'customer-001', name: 'Asha Verma', tier: 'gold', email: 'asha@example.test'},
    'customer-002': {id: 'customer-002', name: 'Ravi Nair', tier: 'restricted', email: 'ravi@example.test'}
}

function freshState() {
    return {
        orders: new Map(),
        payments: new Map(),
        notifications: new Map(),
        adminUsers: new Map(),
        counters: {order: 0, payment: 0, notification: 0, user: 0, request: 0},
        requests: [],
        held: new Set()
    }
}

let state = freshState()

const pad = (n) => String(n).padStart(3, '0')
const nextId = (kind) => `${kind}-${pad(++state.counters[kind])}`

function send(res, status, body, extraHeaders = {}) {
    if (body === undefined) {
        res.writeHead(status, extraHeaders)
        res.end()
        return
    }
    const text = JSON.stringify(body)
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(text), ...extraHeaders
    })
    res.end(text)
}

function readBody(req) {
    return new Promise((resolve) => {
        const chunks = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            if (!text) return resolve(undefined)
            try {
                resolve(JSON.parse(text))
            } catch {
                resolve({__unparseable: text})
            }
        })
        req.on('error', () => resolve(undefined))
    })
}

function bearerOf(req) {
    const raw = req.headers['authorization']
    if (typeof raw !== 'string') return {token: undefined, identity: undefined}
    const m = /^Bearer\s+(\S+)$/i.exec(raw.trim())
    const token = m?.[1]
    return {token, identity: token ? tokenToIdentity.get(token) : undefined}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname
    const query = Object.fromEntries(url.searchParams.entries())

    // ── control plane ─────────────────────────────────────────────────────────
    if (req.method === 'GET' && path === '/health') return send(res, 200, {
        status: 'ok',
        requests: state.requests.length
    })
    if (req.method === 'GET' && path === '/__admin/requests') {
        let list = state.requests
        if (query.method) list = list.filter((r) => r.method === query.method.toUpperCase())
        if (query.path) list = list.filter((r) => r.path === query.path)
        return send(res, 200, list)
    }
    if (req.method === 'POST' && path === '/__admin/reset') {
        for (const held of state.held) {
            try {
                held.destroy()
            } catch { /* already gone */
            }
        }
        state = freshState()
        return send(res, 200, {reset: true})
    }
    if (req.method === 'GET' && path === '/__admin/state') {
        return send(res, 200, {
            orders: [...state.orders.values()],
            payments: [...state.payments.values()],
            notifications: [...state.notifications.values()],
            adminUsers: [...state.adminUsers.values()],
            counters: state.counters
        })
    }
    if (path.startsWith('/__admin/')) return send(res, 404, {error: 'unknown control route'})

    // ── business surface: log first, so even a rejected call is visible ───────
    const body = await readBody(req)
    const {token, identity} = bearerOf(req)
    const entry = {
        seq: ++state.counters.request,
        receivedAt: new Date().toISOString(),
        method: req.method,
        path,
        query,
        body,
        identity: identity ?? null,
        tokenFingerprint: token ? createHash('sha256').update(token).digest('hex').slice(0, 12) : null,
        headers: {
            'x-correlation-id': req.headers['x-correlation-id'] ?? null,
            'x-idempotency-key': req.headers['x-idempotency-key'] ?? null,
            'x-mcp-service': req.headers['x-mcp-service'] ?? null,
            'x-mcp-tool': req.headers['x-mcp-tool'] ?? null,
            'x-request-source': req.headers['x-request-source'] ?? null,
            'x-harbor-server-id': req.headers['x-harbor-server-id'] ?? null,
            'x-harbor-client-id': req.headers['x-harbor-client-id'] ?? null,
            'x-harbor-execution-id': req.headers['x-harbor-execution-id'] ?? null
        },
        status: null
    }
    state.requests.push(entry)
    const reply = (status, payload, headers) => {
        entry.status = status;
        send(res, status, payload, headers)
    }

    if (query.delayMs !== undefined) {
        const delay = Math.min(Math.max(Number(query.delayMs) || 0, 0), MAX_DELAY_MS)
        await sleep(delay)
    }

    if (!identity) return reply(401, {error: 'unauthorized', reason: token ? 'unknown identity' : 'missing bearer'})

    // FAILURE injection
    if (req.method === 'POST' && path === '/unstable') {
        const mode = String(body?.mode ?? query.status ?? '200')
        if (mode === 'timeout') {
            entry.status = 'held'
            state.held.add(res)
            await sleep(TIMEOUT_HOLD_MS)
            state.held.delete(res)
            if (!res.writableEnded) reply(200, {mode, note: 'released after hold'})
            return
        }
        const status = Number(mode)
        if (!Number.isInteger(status) || status < 200 || status > 599) return reply(400, {error: `unknown mode "${mode}"`})
        return reply(status, {mode: status, ok: status < 400, echo: body ?? null})
    }

    if (req.method === 'GET' && path === '/ping') return reply(200, {pong: true, identity})

    let m
    if (req.method === 'GET' && (m = /^\/customers\/([^/]+)$/.exec(path))) {
        const c = CUSTOMERS[m[1]]
        return c ? reply(200, c) : reply(404, {error: 'customer not found'})
    }
    if (req.method === 'GET' && (m = /^\/customers\/([^/]+)\/payment-details$/.exec(path))) {
        const c = CUSTOMERS[m[1]]
        return c ? reply(200, {
            customerId: c.id,
            cardLast4: '4242',
            brand: 'visa',
            expiry: '2029-01'
        }) : reply(404, {error: 'customer not found'})
    }
    if (req.method === 'POST' && path === '/orders') {
        if (!body || typeof body !== 'object' || !body.customerId || typeof body.amount !== 'number') {
            return reply(400, {error: 'customerId and numeric amount are required'})
        }
        const order = {
            id: nextId('order'),
            customerId: body.customerId,
            amount: body.amount,
            items: body.items ?? [],
            status: 'created',
            createdBy: identity
        }
        state.orders.set(order.id, order)
        return reply(201, order)
    }
    if ((m = /^\/orders\/([^/]+)$/.exec(path))) {
        const order = state.orders.get(m[1])
        if (req.method === 'GET') return order ? reply(200, order) : reply(404, {error: 'order not found'})
        if (req.method === 'PATCH') {
            if (!order) return reply(404, {error: 'order not found'})
            Object.assign(order, body ?? {}, {updatedBy: identity})
            return reply(200, order)
        }
        if (req.method === 'DELETE') {
            if (!order) return reply(404, {error: 'order not found'})
            state.orders.delete(m[1])
            return reply(204)
        }
    }
    if (req.method === 'POST' && path === '/payments') {
        if (!body || typeof body.amount !== 'number') return reply(400, {error: 'numeric amount is required'})
        const payment = {
            id: nextId('payment'),
            orderId: body.orderId ?? null,
            amount: body.amount,
            status: 'captured',
            chargedBy: identity
        }
        state.payments.set(payment.id, payment)
        return reply(201, payment)
    }
    if (req.method === 'POST' && path === '/notifications') {
        const n = {
            id: nextId('notification'),
            customerId: body?.customerId ?? null,
            message: body?.message ?? '',
            sentBy: identity
        }
        state.notifications.set(n.id, n)
        return reply(201, n)
    }
    if (req.method === 'POST' && path === '/admin/users') {
        const u = {
            id: nextId('user'),
            username: body?.username ?? 'anonymous',
            role: body?.role ?? 'user',
            createdBy: identity
        }
        state.adminUsers.set(u.id, u)
        return reply(201, u)
    }
    if (req.method === 'GET' && path === '/admin/users') return reply(200, {users: [...state.adminUsers.values()]})

    return reply(404, {error: 'not found'})
})

server.listen(PORT, HOST, () => {
    console.log(`[mock-api] listening on http://${HOST}:${PORT} (identities: ${identities.accepted.join(', ')})`)
})

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
    server.close();
    process.exit(0)
})
