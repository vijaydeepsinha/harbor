// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, afterEach, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { ERR, APPROVAL_STATUS, EXECUTION_STATUS } from '../../src/core/constants.js'
import { TokenInvalidError } from '../../src/core/types/auth.types.js'
import { hashAuthenticatedPrincipal } from '../../src/core/utils/user-id-hash.js'

vi.mock('@modelcontextprotocol/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/server')>()
  return { ...actual, createMcpHandler: vi.fn(() => ({ fetch: vi.fn() })) }
})
vi.mock('@modelcontextprotocol/node', () => ({ toNodeHandler: vi.fn(() => vi.fn()) }))

import { startHttpGateway } from '../../src/runtime/http/http-gateway.js'
import { ServiceRegistry } from '../../src/runtime/registry/service-registry.js'
import { ActivityJournal } from '../../src/runtime/execution/activity-journal.js'
import { makeConnector, makeResources, makeRuntime, silentLogger } from './code-mode-harness.js'

const TOKEN = 'route-test-token-0123456789abcdefghijklmnop'
const OTHER_TOKEN = 'route-other-token-0123456789abcdefgh'

function makeRouteRegistry() {
  const registry = new ServiceRegistry()
  const resources = makeResources('trafficking', makeConnector().connector)
  resources.authMiddleware.validateRequest = async (authorization) => {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : ''
    let userId: string
    if (token === TOKEN) userId = 'user-42'
    else if (token === OTHER_TOKEN) userId = 'user-99'
    else throw new TokenInvalidError()

    return {
      payload: {
        access_token: token,
        token_type: 'bearer',
        expires_in: 3600,
        scope: '',
        metadata: { userId }
      },
      invalidate: async () => {}
    }
  }
  registry.register('trafficking', resources)
  return registry
}

async function start(durableExecutionRuntime: ReturnType<typeof makeRuntime>, registry = makeRouteRegistry()) {
  const handle = startHttpGateway({
    host: '127.0.0.1', port: 0,
    createMcpServer: () => { throw new Error('not expected') },
    registry, logger: silentLogger, durableExecutionRuntime
  })
  await new Promise<void>(resolve => handle.server.once('listening', () => resolve()))
  const { port } = handle.server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => handle.server.close(err => err ? reject(err) : resolve()))
  }
}

/** An execution paused on approval #1, as the tool would leave it. */
async function seedPaused(rt: ReturnType<typeof makeRuntime>, token = TOKEN, userId = 'user-42') {
  const userIdHash = hashAuthenticatedPrincipal({
    access_token: token,
    metadata: { userId }
  })
  const exec = await rt.executionManager.create({ service: 'trafficking', code: 'async () => 1', userIdHash })
  await rt.executionManager.beginRun(exec.executionId)
  const journal = new ActivityJournal(rt.persistence, exec.executionId, 'trafficking', 1)
  const request = { method: 'POST' as const, rawPath: '/campaigns/C1', specPath: '/campaigns/{id}', operationId: 'updateCampaign', body: { action: 'activate' } }
  await journal.next(request)
  const approval = await rt.approvals.request(exec.executionId, 1, { ...request, service: 'trafficking', reason: 'r', matchedRules: ['x'] })
  await journal.recordWaitingApproval(1, request, approval.approvalId)
  await rt.executionManager.endRun(exec.executionId, { kind: 'waitingApproval', approvalId: approval.approvalId })
  return { executionId: exec.executionId, approvalId: approval.approvalId }
}

describe('execution routes', () => {
  let cleanup: (() => Promise<void>) | null = null
  afterEach(async () => { if (cleanup) { await cleanup(); cleanup = null } })

  it('requires a bearer, 404s unknown executions, and returns the full inspection', async () => {
    const rt = makeRuntime()
    const { executionId, approvalId } = await seedPaused(rt)
    const { baseUrl, close } = await start(rt); cleanup = close

    expect((await fetch(`${baseUrl}/executions/${executionId}`)).status).toBe(401)
    const forged = await fetch(`${baseUrl}/executions/${executionId}`, {
      headers: { Authorization: 'Bearer forged-token-0123456789abcdefghijkl' }
    })
    expect(forged.status).toBe(401)

    const missing = await fetch(`${baseUrl}/executions/nope`, { headers: { Authorization: `Bearer ${TOKEN}` } })
    expect(missing.status).toBe(404)
    expect((await missing.json() as { code: string }).code).toBe(ERR.EXECUTION_NOT_FOUND)

    const res = await fetch(`${baseUrl}/executions/${executionId}`, { headers: { Authorization: `Bearer ${TOKEN}` } })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body['execution']).toMatchObject({ executionId, status: EXECUTION_STATUS.WAITING_APPROVAL, pendingApprovalId: approvalId })
    expect((body['activities'] as unknown[]).length).toBe(1)
    expect((body['approvals'] as Array<{ status: string }>)[0]?.status).toBe(APPROVAL_STATUS.PENDING)
    expect(Array.isArray(body['history'])).toBe(true)
    expect(Array.isArray(body['decisions'])).toBe(true)
  })

  it('POST decides an approval once; validates body and ownership', async () => {
    const rt = makeRuntime()
    const { executionId, approvalId } = await seedPaused(rt)
    const { baseUrl, close } = await start(rt); cleanup = close
    const post = (path: string, body: unknown) => fetch(`${baseUrl}${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })

    const bad = await post(`/executions/${executionId}/approvals/${approvalId}`, { action: 'maybe' })
    expect(bad.status).toBe(400)

    const wrongExec = await post(`/executions/other-exec/approvals/${approvalId}`, { action: 'accept' })
    expect(wrongExec.status).toBe(404)

    for (const approve of [undefined, 'true', 1, null]) {
      const malformed = await post(`/executions/${executionId}/approvals/${approvalId}`, { action: 'accept', ...(approve !== undefined ? { approve } : {}) })
      expect(malformed.status, `approve=${String(approve)}`).toBe(400) // an accept that does not say approve: true is not a yes
    }
    expect((await rt.approvals.get(approvalId)).status).toBe(APPROVAL_STATUS.PENDING)

    const ok = await post(`/executions/${executionId}/approvals/${approvalId}`, { action: 'accept', approve: true, comment: 'fine' })
    expect(ok.status).toBe(200)
    const decided = await ok.json() as { outcome: string; approval: { status: string; comment: string; decidedVia: string }; executionStatus: string }
    expect(decided.outcome).toBe('APPROVED')
    expect(decided.approval).toMatchObject({ status: APPROVAL_STATUS.APPROVED, comment: 'fine', decidedVia: 'http' })
    expect(decided.executionStatus).toBe(EXECUTION_STATUS.WAITING_APPROVAL) // decided ⇒ resumable

    const again = await post(`/executions/${executionId}/approvals/${approvalId}`, { action: 'decline' })
    expect(again.status).toBe(409)
    expect((await again.json() as { code: string }).code).toBe(ERR.APPROVAL_ALREADY_DECIDED)

    const get = await fetch(`${baseUrl}/executions/${executionId}/approvals/${approvalId}`, { headers: { Authorization: `Bearer ${TOKEN}` } })
    expect(get.status).toBe(405)
  })

  it('rejects a different authenticated principal without exposing or deciding the execution', async () => {
    const rt = makeRuntime()
    const { executionId, approvalId } = await seedPaused(rt)
    const { baseUrl, close } = await start(rt); cleanup = close
    const headers = { Authorization: `Bearer ${OTHER_TOKEN}` }

    const inspection = await fetch(`${baseUrl}/executions/${executionId}`, { headers })
    expect(inspection.status).toBe(403)

    const decision = await fetch(`${baseUrl}/executions/${executionId}/approvals/${approvalId}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'accept' })
    })
    expect(decision.status).toBe(403)
    expect((await rt.approvals.get(approvalId)).status).toBe(APPROVAL_STATUS.PENDING)
  })

  it('refuses an approval that belongs to another principal execution, even with a valid token for one of them', async () => {
    const rt = makeRuntime()
    const mine = await seedPaused(rt, TOKEN, 'user-42')
    const theirs = await seedPaused(rt, OTHER_TOKEN, 'user-99')
    const { baseUrl, close } = await start(rt); cleanup = close

    // A valid token for *my* execution, paired with *their* approval id.
    const res = await fetch(`${baseUrl}/executions/${mine.executionId}/approvals/${theirs.approvalId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'accept' })
    })

    expect(res.status).toBe(404)
    const refused = await res.json() as { code: string; error: string }
    expect(refused.code).toBe(ERR.APPROVAL_NOT_FOUND)
    expect(refused.error).not.toContain(theirs.executionId) // the reply does not confirm whose approval it is
    // Their approval is untouched and their execution still pauses on it.
    expect((await rt.approvals.get(theirs.approvalId)).status).toBe(APPROVAL_STATUS.PENDING)
    expect((await rt.executionManager.load(theirs.executionId)).status).toBe(EXECUTION_STATUS.WAITING_APPROVAL)
  })

  it('answers an over-limit POST body with a readable 413, not a reset connection', async () => {
    const rt = makeRuntime()
    const { executionId, approvalId } = await seedPaused(rt)
    const { baseUrl, close } = await start(rt); cleanup = close
    const res = await fetch(`${baseUrl}/executions/${executionId}/approvals/${approvalId}`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'accept', approve: true, comment: 'x'.repeat(100 * 1024) })
    })
    expect(res.status).toBe(413)
    expect((await res.json() as { code: string }).code).toBe(ERR.PAYLOAD_TOO_LARGE)
    expect((await rt.approvals.get(approvalId)).status).toBe(APPROVAL_STATUS.PENDING)
  })

  it('returns a conflict when another operation holds the execution lock', async () => {
    const rt = makeRuntime()
    const { executionId, approvalId } = await seedPaused(rt)
    expect(await rt.persistence.acquireLock(executionId)).toBe(true)
    const { baseUrl, close } = await start(rt); cleanup = close

    const decision = await fetch(`${baseUrl}/executions/${executionId}/approvals/${approvalId}`, {
      method: 'POST',
      headers: { Authorization: ['Bearer', TOKEN].join(' '), 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'accept' })
    })

    expect(decision.status).toBe(409)
    expect((await decision.json() as { code: string }).code).toBe(ERR.EXECUTION_LOCKED)
    expect((await rt.approvals.get(approvalId)).status).toBe(APPROVAL_STATUS.PENDING)
    expect((await rt.executionManager.load(executionId)).status).toBe(EXECUTION_STATUS.WAITING_APPROVAL)
    await rt.persistence.releaseLock(executionId)
  })

  it('decline over HTTP denies the execution', async () => {
    const rt = makeRuntime()
    const { executionId, approvalId } = await seedPaused(rt)
    const { baseUrl, close } = await start(rt); cleanup = close
    const res = await fetch(`${baseUrl}/executions/${executionId}/approvals/${approvalId}`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'decline' })
    })
    expect((await res.json() as { executionStatus: string }).executionStatus).toBe(EXECUTION_STATUS.DENIED)
  })

  it('keeps the owner authorized after the middleware silently refreshes the backend token', async () => {
    // The gateway refreshes an expiring backend token behind the caller, who
    // keeps presenting the same bearer. Identity must follow the bearer, not
    // the rotating `access_token`, or the owner is locked out of their own
    // paused execution forever.
    const registry = new ServiceRegistry()
    const resources = makeResources('trafficking', makeConnector().connector)
    let rotation = 0
    resources.authMiddleware.validateRequest = async (authorization) => {
      const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : ''
      if (token !== TOKEN) throw new TokenInvalidError()
      rotation += 1
      return {
        payload: { access_token: `backend-token-${rotation}`, token_type: 'bearer', expires_in: 3600, scope: '' },
        invalidate: async () => {}
      }
    }
    registry.register('trafficking', resources)

    const rt = makeRuntime()
    const first = await resources.authMiddleware.validateRequest(`Bearer ${TOKEN}`, 'c')
    const userIdHash = hashAuthenticatedPrincipal(first.payload, TOKEN)
    const exec = await rt.executionManager.create({ service: 'trafficking', code: 'async () => 1', userIdHash })
    const { baseUrl, close } = await start(rt, registry); cleanup = close

    const res = await fetch(`${baseUrl}/executions/${exec.executionId}`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    })
    expect(res.status).toBe(200)
  })

  it('is absent when no durable execution runtime is configured', async () => {
    const handle = startHttpGateway({
      host: '127.0.0.1', port: 0, createMcpServer: () => { throw new Error('no') }, registry: new ServiceRegistry(), logger: silentLogger
    })
    await new Promise<void>(resolve => handle.server.once('listening', () => resolve()))
    const { port } = handle.server.address() as AddressInfo
    cleanup = () => new Promise<void>((resolve, reject) => handle.server.close(err => err ? reject(err) : resolve()))
    const res = await fetch(`http://127.0.0.1:${port}/executions/x`, { headers: { Authorization: `Bearer ${TOKEN}` } })
    expect(res.status).toBe(404)
    expect((await res.json() as { code: string }).code).toBe(ERR.NOT_FOUND)
  })
})
