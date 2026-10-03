// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * Per-test scenario context: fresh clients, a mock-API reset before each
 * test, and — when the test fails — a dump of everything needed to debug a
 * governance failure: the MCP transcript, every touched execution's
 * inspection, the mock's request log and the correlation ids.
 */
import {mkdirSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {afterEach, beforeEach, type TestContext} from 'vitest'
import {env} from './env.js'
import {McpClient, type McpClientOptions} from '../client/mcp-client.js'
import {HarborAdmin} from '../client/harbor-admin.js'
import {MockApi} from '../client/mock-api.js'
import {IDENTITIES, type Identity} from '../fixtures/identities.js'

export interface Scenario {
    /** Human-readable id printed in failure dumps. */
    testId: string
    mock: MockApi
    /** Admin client authenticated as `alice` against the main gateway. */
    admin: HarborAdmin

    /** A client for the main gateway as the given identity (elicitation on by default). */
    client(identity: Identity, opts?: Partial<McpClientOptions>): McpClient

    /** A client for the strict gateway. Throws with a reason when the strict instance is not configured. */
    strictClient(identity: Identity, opts?: Partial<McpClientOptions>): McpClient

    strictAdmin(identity?: Identity): HarborAdmin

    adminAs(identity: Identity, baseUrl?: string): HarborAdmin

    /** Register an execution id so its inspection is dumped on failure. */
    track(executionId: string | undefined): void

    note(key: string, value: unknown): void
}

/**
 * Call once at the top of a describe block. Returns a getter for the current
 * test's scenario (the object is rebuilt in `beforeEach`).
 */
export function useScenario(): () => Scenario {
    let current: Scenario | undefined
    const clients: McpClient[] = []
    const executions = new Set<string>()
    const notes: Record<string, unknown> = {}

    beforeEach(async (ctx) => {
        clients.length = 0
        executions.clear()
        for (const k of Object.keys(notes)) delete notes[k]
        const mock = new MockApi(env.mockApiUrl)
        await mock.reset()
        const make = (baseUrl: string, identity: Identity, opts?: Partial<McpClientOptions>): McpClient => {
            const c = new McpClient({baseUrl, token: IDENTITIES[identity], clientName: `e2e:${identity}`, ...opts})
            clients.push(c)
            return c
        }
        current = {
            testId: `${ctx.task.file?.name ?? 'unknown'} :: ${ctx.task.name}`,
            mock,
            admin: new HarborAdmin(env.mcpBaseUrl, IDENTITIES.alice),
            client: (identity, opts) => make(env.mcpBaseUrl, identity, opts),
            strictClient: (identity, opts) => {
                if (!env.strictBaseUrl) throw new Error('MCP_STRICT_BASE_URL is not set — the strict instance is required for this test')
                return make(env.strictBaseUrl, identity, opts)
            },
            strictAdmin: (identity = 'alice') => {
                if (!env.strictBaseUrl) throw new Error('MCP_STRICT_BASE_URL is not set — the strict instance is required for this test')
                return new HarborAdmin(env.strictBaseUrl, IDENTITIES[identity])
            },
            adminAs: (identity, baseUrl = env.mcpBaseUrl) => new HarborAdmin(baseUrl, IDENTITIES[identity]),
            track: (id) => {
                if (id) executions.add(id)
            },
            note: (k, v) => {
                notes[k] = v
            }
        }
    })

    afterEach(async (ctx) => {
        const failed = ctx.task.result?.state === 'fail'
        if (!failed && !env.debug) return
        if (!current) return
        await dump(ctx, current, clients, [...executions], notes, failed)
    })

    return () => {
        if (!current) throw new Error('useScenario(): no active test')
        return current
    }
}

async function dump(ctx: TestContext, s: Scenario, clients: McpClient[], executions: string[], notes: Record<string, unknown>, failed: boolean): Promise<void> {
    const safe = (x: string) => x.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120)
    const dir = join(env.artifactsDir, 'failures', safe(ctx.task.file?.name ?? 'unknown'), safe(ctx.task.name))
    mkdirSync(dir, {recursive: true})
    const errors = ctx.task.result?.errors?.map(e => ({message: e.message, stack: e.stack})) ?? []
    const inspections: Record<string, unknown> = {}
    for (const id of executions) {
        try {
            inspections[id] = (await s.admin.inspectRaw(id)).body
        } catch (err) {
            inspections[id] = {unavailable: String(err)}
        }
    }
    let mockRequests: unknown = null
    try {
        mockRequests = await s.mock.requests()
    } catch (err) {
        mockRequests = {unavailable: String(err)}
    }
    const transcript = clients.flatMap(c => c.transcript.map(t => ({
        client: c.opts.clientName,
        baseUrl: c.baseUrl, ...t
    })))
    const context = {
        testId: s.testId,
        state: failed ? 'failed' : 'passed (DEBUG_GOVERNANCE dump)',
        errors,
        executionIds: executions,
        approvalIds: Object.values(inspections).flatMap(i => ((i as {
            approvals?: Array<{ approvalId: string }>
        })?.approvals ?? []).map(a => a.approvalId)),
        jsonRpcIds: transcript.map(t => (t.request.body as { id?: unknown })?.id).filter(v => v !== undefined),
        downstreamCorrelationIds: Array.isArray(mockRequests) ? (mockRequests as Array<{
            headers: Record<string, unknown>
        }>).map(r => r.headers['x-correlation-id']) : [],
        notes,
        env: {mcpBaseUrl: env.mcpBaseUrl, strictBaseUrl: env.strictBaseUrl, mockApiUrl: env.mockApiUrl}
    }
    writeFileSync(join(dir, 'context.json'), JSON.stringify(context, null, 2))
    writeFileSync(join(dir, 'mcp-transcript.json'), JSON.stringify(transcript, null, 2))
    writeFileSync(join(dir, 'executions.json'), JSON.stringify(inspections, null, 2))
    writeFileSync(join(dir, 'downstream-requests.json'), JSON.stringify(mockRequests, null, 2))
    if (failed) {
        const lines = [
            '', 'TEST FAILED', `test: ${s.testId}`,
            ...executions.map(id => `executionId: ${id}`),
            ...context.approvalIds.map(id => `approvalId: ${id}`),
            ...errors.map(e => `error: ${e.message}`),
            `diagnostics: ${dir}`, ''
        ]
        process.stderr.write(lines.join('\n'))
    }
}
