// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, vi } from 'vitest'
import pino from 'pino'
import { AuditPipeline, executionStateOf } from '../../src/runtime/observability/audit-pipeline.js'
import { ConsoleAuditSink } from '../../src/adapters/observability/console-audit-sink.js'
import { writeAuditRecord, type AuditRecord } from '../../src/runtime/observability/audit.js'
import { buildAuditSinks, registerAuditSinkBackend } from '../../src/wiring/strategy-builders.js'
import { buildCodeModeRuntime, type CodeModeRuntime } from '../../src/runtime/execution/code-mode-runtime.js'
import { registerExecuteApiTool } from '../../src/tools/execute-api.tool.js'
import type { AuditEvent, AuditSink } from '../../src/spi/observability/audit-sink.js'
import type { ExecutionInspection } from '../../src/runtime/execution/execution-manager.js'
import type { Logger } from '../../src/core/types/logger.types.js'
import type { MetricsRegistry } from '../../src/runtime/observability/metrics.js'
import { EXECUTION_STATUS, GOVERNANCE_DECISION, TOOL, APPROVAL_STATUS } from '../../src/core/constants.js'
import {
  makeFakeServer, makeRegistry, makeResources, makeConnector, makeRuntime, makeCtx, retryCtx, globalConfig, silentLogger
} from './code-mode-harness.js'

const silent = pino({ level: 'silent' }) as unknown as Logger

function capturingSink(name = 'capture') {
  const events: AuditEvent[] = []
  const sink: AuditSink = { name, write: e => { events.push(e) } }
  return { sink, events }
}

function capturingLogger() {
  const lines: Array<{ obj: unknown; msg: string }> = []
  const logger = { info: (obj: unknown, msg: string) => { lines.push({ obj, msg }) }, warn() {}, error() {}, debug() {} } as unknown as Logger
  return { logger, lines }
}

const record = (service = 'product'): AuditRecord => ({
  auditId: 'a', timestamp: 't', service, environment: 'dev', userIdHash: 'h', sessionId: 's', correlationId: 'c',
  tool: TOOL.API_EXECUTE, authStrategy: 'static-token', idempotencyStrategy: 'noop', circuitBreakerStrategy: 'noop',
  codeSubmitted: 'async () => 1', endpointsAccessed: [], apiCallCount: 0, durationMs: 1, outcome: 'success'
})

describe('audit pipeline', () => {
  it('delivers every event to every sink; one failing sink neither stops the others nor throws', async () => {
    const a = capturingSink('a')
    const b = capturingSink('b')
    const errors: unknown[] = []
    const logger = { info() {}, warn() {}, debug() {}, error: (o: unknown) => { errors.push(o) } } as unknown as Logger
    const broken: AuditSink = { name: 'broken', write: () => { throw new Error('bucket unreachable') } }
    const pipeline = new AuditPipeline([a.sink, broken, b.sink], logger)
    await pipeline.publish({ kind: 'audit', record: record() })
    expect(a.events).toHaveLength(1)
    expect(b.events).toHaveLength(1)
    expect(errors).toEqual([{ sink: 'broken', kind: 'audit', error: 'bucket unreachable' }])
    expect(pipeline.sinkNames).toEqual(['a', 'broken', 'b'])
    await new AuditPipeline([], logger).publish({ kind: 'audit', record: record() }) // no sinks: no-op
  })

  it('closes every sink on shutdown, even when one fails to close', async () => {
    const closed: string[] = []
    const pipeline = new AuditPipeline([
      { name: 'x', write() {}, close: () => { throw new Error('nope') } },
      { name: 'y', write() {}, close: () => { closed.push('y') } }
    ], silent)
    await pipeline.close()
    expect(closed).toEqual(['y'])
  })

  it('console sink: the audit line as before, and an execution-state line, on the owning service\'s logger', () => {
    const trafficking = capturingLogger()
    const other = capturingLogger()
    const sink = new ConsoleAuditSink(service => (service === 'trafficking' ? trafficking.logger : other.logger))
    sink.write({ kind: 'audit', record: record('trafficking') })
    const state = executionStateOf(inspection()) // an execution of the trafficking service
    sink.write({ kind: 'execution', state })
    expect(trafficking.lines).toEqual([
      { obj: record('trafficking'), msg: 'audit' },
      { obj: { execution: state }, msg: 'execution-state' }
    ])
    expect(other.lines).toEqual([])
  })

  it('AUDIT_SINKS builds console by default, registered sinks by name, and refuses an unknown one', () => {
    const loggerFor = () => silent
    expect(buildAuditSinks(['console'], { loggerFor }).map(s => s.name)).toEqual(['console'])
    registerAuditSinkBackend('test-s3', () => ({ name: 's3', write() {} }))
    expect(buildAuditSinks(['console', 'test-s3'], { loggerFor }).map(s => s.name)).toEqual(['console', 's3'])
    expect(() => buildAuditSinks(['console', 'kafka'], { loggerFor })).toThrow(/Unknown audit sink: "kafka"/)
  })

  it('writeAuditRecord goes to the pipeline when one is wired, to the logger otherwise, and nowhere with ENABLE_AUDIT off', async () => {
    const on = { ...globalConfig, observability: { ...globalConfig.observability, enableAudit: true } }
    const { sink, events } = capturingSink()
    const direct = capturingLogger()
    writeAuditRecord(record(), direct.logger, on, new AuditPipeline([sink], silent))
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(direct.lines).toEqual([])
    writeAuditRecord(record(), direct.logger, on)
    expect(direct.lines).toEqual([{ obj: record(), msg: 'audit' }])
    writeAuditRecord(record(), direct.logger, globalConfig /* enableAudit: false */, new AuditPipeline([sink], silent))
    await new Promise(r => setImmediate(r))
    expect(events).toHaveLength(1)
  })

  it('an execution-state snapshot carries statuses, approvals and decisions — never bodies, responses or the program', () => {
    const state = executionStateOf(inspection())
    expect(state).toMatchObject({
      executionId: 'e-1', status: EXECUTION_STATUS.WAITING_APPROVAL, pendingApprovalId: 'ap-1',
      activities: [
        { sequence: 1, method: 'GET', specPath: '/campaigns', status: 'COMPLETED', httpStatus: 200 },
        { sequence: 2, method: 'POST', specPath: '/campaigns/{id}/finalize', operationId: 'finalizeCampaign', status: 'WAITING_APPROVAL', approvalId: 'ap-1' }
      ],
      approvals: [{ approvalId: 'ap-1', status: APPROVAL_STATUS.PENDING }],
      decisions: [{ activitySequence: 2, decision: 'REQUIRE_APPROVAL', matchedRules: ['r'] }]
    })
    const json = JSON.stringify(state)
    for (const secret of ['SECRET-BODY', 'SECRET-RESPONSE', 'SECRET-PROGRAM', 'SECRET-QUERY']) expect(json).not.toContain(secret)
  })

  it('the runtime publishes every persisted execution state change (runs and human decisions)', async () => {
    const { sink, events } = capturingSink()
    const rt = await buildCodeModeRuntime({
      store: { type: 'in-memory' },
      governance: { rulesDir: '/nonexistent', defaultDecision: GOVERNANCE_DECISION.DENY, approvalTtlSec: 600 }
    }, silent, new AuditPipeline([sink], silent))
    const rec = await rt.manager.create({ service: 'svc', code: 'c', userIdHash: 'h' })
    await rt.manager.beginRun(rec.executionId)
    await rt.manager.endRun(rec.executionId, { kind: 'waitingApproval', approvalId: 'ap-1' })
    await rt.manager.markApprovalDecided(rec.executionId, EXECUTION_STATUS.DENIED, { code: 'GOVERNANCE_DENIED', message: 'rejected' })
    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(events.map(e => e.kind === 'execution' ? e.state.status : e.kind)).toEqual([EXECUTION_STATUS.WAITING_APPROVAL, EXECUTION_STATUS.DENIED])
    await rt.shutdown()
  })

  it('api_execute end to end: an audit record per call, and the execution state at the pause and at completion', async () => {
    const { sink, events } = capturingSink()
    const pipeline = new AuditPipeline([sink], silent)
    // the manager publishes its state changes, as buildCodeModeRuntime wires it
    const rt: CodeModeRuntime = makeRuntime(
      [{ name: 'finalize-needs-approval', match: { service: 'trafficking', operation: 'finalizeCampaign' }, action: { type: 'REQUIRE_APPROVAL' } }],
      GOVERNANCE_DECISION.ALLOW, undefined,
      { onStateChange: id => { void rt.manager.inspect(id).then(i => pipeline.publish({ kind: 'execution', state: executionStateOf(i) })) } }
    )
    const { handlers, server } = makeFakeServer()
    const on = { ...globalConfig, observability: { ...globalConfig.observability, enableAudit: true } }
    const resources = makeResources('trafficking', makeConnector().connector)
    registerExecuteApiTool(server, makeRegistry({ trafficking: resources }), on, silentLogger, { increment() {}, stop() {} } as unknown as MetricsRegistry, 'tok', rt, pipeline)
    const handler = handlers[TOOL.API_EXECUTE]!
    const program = `async () => { const c = await api.request({ method: 'GET', path: '/campaigns' }); return (await api.request({ method: 'POST', path: '/campaigns/' + c.data[0].id + '/finalize', body: { secret: 'SECRET-BODY' } })).data }`
    const paused = await handler({ service: 'trafficking', code: program }, makeCtx())
    await handler({ service: 'trafficking', code: program }, await retryCtx(rt, paused, { action: 'accept', approve: true }))
    await vi.waitFor(() => expect(events.filter(e => e.kind === 'execution')).toHaveLength(2))
    const audits = events.filter((e): e is Extract<AuditEvent, { kind: 'audit' }> => e.kind === 'audit')
    expect(audits.map(e => e.record.outcome)).toEqual(['approval_required', 'success'])
    const states = events.filter((e): e is Extract<AuditEvent, { kind: 'execution' }> => e.kind === 'execution').map(e => e.state)
    expect(states.map(s => s.status)).toEqual([EXECUTION_STATUS.WAITING_APPROVAL, EXECUTION_STATUS.COMPLETED])
    expect(states[1]?.activities.map(a => a.status)).toEqual(['COMPLETED', 'COMPLETED'])
    expect(JSON.stringify(states)).not.toContain('SECRET-BODY')
  })
})

function inspection(): ExecutionInspection {
  return {
    execution: {
      executionId: 'e-1', service: 'trafficking', originalCode: 'SECRET-PROGRAM', status: EXECUTION_STATUS.WAITING_APPROVAL,
      userIdHash: 'h', createdAt: 't0', updatedAt: 't1', currentActivity: 2, runCount: 1, pendingApprovalId: 'ap-1'
    },
    activities: [
      { executionId: 'e-1', sequence: 1, service: 'trafficking', status: 'COMPLETED', runIndex: 1, createdAt: 't', updatedAt: 't',
        request: { method: 'GET', rawPath: '/campaigns', specPath: '/campaigns', query: { q: 'SECRET-QUERY' } },
        response: { status: 200, ok: true, data: { note: 'SECRET-RESPONSE' } } },
      { executionId: 'e-1', sequence: 2, service: 'trafficking', status: 'WAITING_APPROVAL', runIndex: 1, createdAt: 't', updatedAt: 't', approvalId: 'ap-1',
        request: { method: 'POST', rawPath: '/campaigns/C1/finalize', specPath: '/campaigns/{id}/finalize', operationId: 'finalizeCampaign', body: { x: 'SECRET-BODY' } } }
    ],
    approvals: [{ approvalId: 'ap-1', executionId: 'e-1', activitySequence: 2, status: APPROVAL_STATUS.PENDING, createdAt: 't',
      summary: { service: 'trafficking', method: 'POST', specPath: '/campaigns/{id}/finalize', body: { x: 'SECRET-BODY' }, reason: 'r', matchedRules: ['r'] } }],
    decisions: [{ executionId: 'e-1', activitySequence: 2, decision: 'REQUIRE_APPROVAL', reason: 'r', matchedRules: ['r'], ruleVersions: ['r@1#x'], evaluatedAt: 't' }],
    history: []
  }
}
