// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * MCP 2026-07-28 wire-level check of the approval flow through the real SDK
 * handler: per-request envelope, elicitation capability negotiation, an
 * `input_required` result carrying the approval elicitation + sealed
 * `requestState`, the retry with `inputResponses`, requestState integrity
 * (tampering is refused by the seam before the handler runs), and the
 * fallback for clients that do not declare elicitation.
 */
import { describe, it, expect } from 'vitest'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { buildMcpServerFactory } from '../../runtime/http/mcp-server-factory.js'
import { ServiceRegistry } from '../../runtime/registry/service-registry.js'
import type { MetricsRegistry } from '../../runtime/observability/metrics.js'
import { makeConnector, makeResources, makeRuntime, globalConfig, silentLogger } from '../unit/code-mode-harness.js'
import { EXECUTION_ID_META_KEY, APPROVAL_INPUT_KEY, ERR, EXECUTION_STATUS } from '../../core/constants.js'

const PROGRAM = `async () => {
  const c = await api.request({ method: 'GET', path: '/campaigns' })
  const r = await api.request({ method: 'POST', path: '/campaigns/' + c.data[0].id + '/finalize' })
  return { did: r.data.did }
}`
const RULE = { name: 'finalize-needs-approval', match: { operation: 'finalizeCampaign' }, action: { type: 'REQUIRE_APPROVAL', reason: 'finalize is irreversible' } }

function envelope(elicitation: boolean) {
  return {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'wire-test', version: '1' },
    'io.modelcontextprotocol/clientCapabilities': elicitation ? { elicitation: { form: {} } } : {}
  }
}

async function readJsonRpc(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text()
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const data = text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim())
    return JSON.parse(data[data.length - 1] ?? '{}') as Record<string, unknown>
  }
  return JSON.parse(text) as Record<string, unknown>
}

describe('MCP wire: approval via input_required + retry', () => {
  const rt = makeRuntime([RULE])
  const { connector, count } = makeConnector()
  const registry = new ServiceRegistry()
  registry.register('trafficking', makeResources('trafficking', connector))
  const metrics = { increment: () => {}, stop: () => {} } as unknown as MetricsRegistry
  const handler = createMcpHandler(
    buildMcpServerFactory({ registry, globalConfig, logger: silentLogger, metrics, codeMode: rt }),
    { legacy: 'reject' }
  )
  let nextId = 1
  const call = (params: Record<string, unknown>) => handler.fetch(new Request('http://harbor.test/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': 'api_execute'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params })
  }), { authInfo: { token: 'wire-token', clientId: 'harbor-client', scopes: [] } })

  it('pauses with input_required, resumes on the retry, and refuses a tampered requestState', async () => {
    const first = await readJsonRpc(await call({ name: 'api_execute', arguments: { service: 'trafficking', code: PROGRAM }, _meta: envelope(true) }))
    const r1 = first['result'] as Record<string, unknown>
    expect(first['error']).toBeUndefined()
    expect(r1['resultType']).toBe('input_required')
    const inputRequests = r1['inputRequests'] as Record<string, { method: string; params: { mode?: string; message: string; requestedSchema: { required: string[] } } }>
    expect(inputRequests[APPROVAL_INPUT_KEY]?.method).toBe('elicitation/create')
    expect(inputRequests[APPROVAL_INPUT_KEY]?.params.message).toContain('finalize is irreversible')
    expect(inputRequests[APPROVAL_INPUT_KEY]?.params.requestedSchema.required).toEqual(['approve'])
    const requestState = r1['requestState'] as string
    expect(typeof requestState).toBe('string')
    const executionId = (r1['_meta'] as Record<string, unknown> | undefined)?.[EXECUTION_ID_META_KEY] as string | undefined
    expect(typeof executionId).toBe('string')
    expect(count('GET', '/campaigns')).toBe(1)
    expect(count('POST', '/campaigns/C1/finalize')).toBe(0)

    // tampered state: the SDK seam refuses it before api_execute runs (nothing changes)
    const tampered = await readJsonRpc(await call({
      name: 'api_execute', arguments: { service: 'trafficking', code: PROGRAM }, _meta: envelope(true),
      requestState: requestState.slice(0, -3) + 'xyz',
      inputResponses: { [APPROVAL_INPUT_KEY]: { action: 'accept', content: { approve: true } } }
    }))
    expect((tampered['error'] as { code: number }).code).toBe(-32602)
    expect(count('POST', '/campaigns/C1/finalize')).toBe(0)

    // genuine retry: same call, human said yes
    const second = await readJsonRpc(await call({
      name: 'api_execute', arguments: { service: 'trafficking', code: PROGRAM }, _meta: envelope(true),
      requestState,
      inputResponses: { [APPROVAL_INPUT_KEY]: { action: 'accept', content: { approve: true, comment: 'ok' } } }
    }))
    expect(second['error']).toBeUndefined()
    const r2 = second['result'] as Record<string, unknown>
    expect(r2['resultType']).toBe('complete')
    expect(r2['isError']).toBeUndefined()
    const content = r2['content'] as Array<{ text: string }>
    expect(JSON.parse(content[0]!.text)).toEqual({ did: 'POST /campaigns/C1/finalize' })
    expect(count('GET', '/campaigns')).toBe(1)
    expect(count('POST', '/campaigns/C1/finalize')).toBe(1)
    expect((await rt.manager.load(executionId!)).status).toBe(EXECUTION_STATUS.COMPLETED)
  })

  it('a client that does not declare elicitation gets APPROVAL_REQUIRED with the ids, never an elicitation', async () => {
    const res = await readJsonRpc(await call({ name: 'api_execute', arguments: { service: 'trafficking', code: PROGRAM }, _meta: envelope(false) }))
    const r = res['result'] as Record<string, unknown>
    expect(r['resultType']).toBe('complete')
    expect(r['isError']).toBe(true)
    expect(r['inputRequests']).toBeUndefined()
    const body = JSON.parse((r['content'] as Array<{ text: string }>)[0]!.text) as { code: string; executionId: string; approvalId: string }
    expect(body.code).toBe(ERR.APPROVAL_REQUIRED)
    expect((r['_meta'] as Record<string, unknown>)[EXECUTION_ID_META_KEY]).toBe(body.executionId)
    expect((await rt.approvals.get(body.approvalId)).status).toBe('PENDING')
  })
})
