// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * Test harness for the governed `api_execute` tool: a fake McpServer that
 * captures the handler, service resources backed by a counting connector and
 * a small OpenAPI spec, a real in-memory governance runtime, and fake
 * ServerContexts for first calls and MRTR retries.
 */
import pino from 'pino'
import type { McpServer, ServerContext } from '@modelcontextprotocol/server'
import { registerExecuteApiTool } from '../../src/tools/execute-api.tool.js'
import { InMemoryExecutionStore } from '../../src/adapters/execution/in-memory-execution-store.js'
import { ExecutionManager, type ExecutionManagerOptions } from '../../src/runtime/execution/execution-manager.js'
import { ApprovalService } from '../../src/runtime/execution/approval-service.js'
import { createResumeStateCodec, type ResumeState } from '../../src/runtime/execution/request-state.js'
import { GovernanceRuleStore } from '../../src/runtime/governance/rule-store.js'
import { governanceRuleSchema } from '../../src/runtime/governance/rule-schema.js'
import type { GovernanceRuntime } from '../../src/runtime/execution/governance-runtime.js'
import type { ExecutionPersistence } from '../../src/spi/execution/execution-store.js'
import type { LoadedRule } from '../../src/runtime/governance/rule-loader.js'
import { noopCircuitBreaker } from '../../src/adapters/resilience/strategies/noop-circuit-breaker.strategy.js'
import { forwardTokenPermissionGuard } from '../../src/adapters/permissions/strategies/forward-token-permission-guard.strategy.js'
import type { ConnectorAPI, ApiRequest, ExecuteRequestContext } from '../../src/spi/connector/connector-api.js'
import type { ServiceRegistry, ServiceResources } from '../../src/runtime/registry/service-registry.js'
import type { MetricsRegistry } from '../../src/runtime/observability/metrics.js'
import type { GlobalConfig } from '../../src/core/types/config.types.js'
import type { TokenPayload } from '../../src/core/types/auth.types.js'
import type { OpenAPISpec } from '../../src/core/types/spec.types.js'
import { ENV, TOOL, GOVERNANCE_DECISION, EXECUTION_ID_META_KEY, type GovernanceDecisionType } from '../../src/core/constants.js'

export const silentLogger = pino({ level: 'silent' })

export const campaignSpec: OpenAPISpec = {
  openapi: '3.0.3', info: { title: 'Trafficking', version: '1' },
  paths: {
    '/campaigns': { get: { operationId: 'listCampaigns' }, post: { operationId: 'createCampaign' } },
    '/campaigns/{id}': { post: { operationId: 'updateCampaign' } },
    '/campaigns/{id}/creatives': { get: { operationId: 'listCreatives' } },
    '/campaigns/{id}/creative': { post: { operationId: 'attachCreative' } },
    '/campaigns/{id}/finalize': { post: { operationId: 'finalizeCampaign' } }
  }
}

export type ToolHandler = (args: { service: string; code: string }, ctx: unknown) => Promise<Record<string, unknown>>

export function makeFakeServer(): { handlers: Record<string, ToolHandler>; server: McpServer } {
  const handlers: Record<string, ToolHandler> = {}
  const server = {
    registerTool(name: string, _def: unknown, handler: ToolHandler) { handlers[name] = handler }
  } as unknown as McpServer
  return { handlers, server }
}

export function makeConnector() {
  const calls: Array<{ req: ApiRequest; ctx: ExecuteRequestContext }> = []
  const connector: ConnectorAPI = {
    async request(req, ctx) {
      calls.push({ req, ctx })
      if (req.method === 'GET' && req.path === '/campaigns') return { status: 200, ok: true, data: [{ id: 'C1', name: 'Q4' }] }
      if (req.method === 'GET') return { status: 200, ok: true, data: [{ id: 'CR1' }] }
      return { status: 201, ok: true, data: { id: `res-${calls.length}`, did: `${req.method} ${req.path}` } }
    }
  }
  /** Exact method + path count. */
  const count = (method: string, path: string) =>
    calls.filter(c => c.req.method === method && c.req.path === path).length
  return { connector, calls, count }
}

export function makeResources(name: string, connector: ConnectorAPI, userId = 'user-42'): ServiceResources {
  const token: TokenPayload = { access_token: 'tok', token_type: 'bearer', expires_in: 3600, refresh_token: 'r', scope: '', metadata: { userId } }
  return {
    name,
    description: 'test',
    specStore: { getSpec: () => campaignSpec },
    authMiddleware: { validateRequest: async () => ({ payload: token, invalidate: async () => {} }) },
    apiClient: connector,
    circuitBreaker: noopCircuitBreaker(),
    permissionGuard: forwardTokenPermissionGuard(),
    idempotencyKeyTtlMs: 600_000,
    idempotencyStrategyName: 'noop',
    circuitBreakerStrategyName: 'noop',
    authStrategyName: 'static-token',
    sandboxLimits: { memoryLimitMb: 64, executeTimeoutMs: 8000, searchTimeoutMs: 3000, maxApiCalls: 50, maxConcurrentCalls: 5 },
    logger: silentLogger
  } as unknown as ServiceResources
}

export function makeRegistry(entries: Record<string, ServiceResources>): ServiceRegistry {
  return { get: (k: string) => entries[k], serviceNames: () => Object.keys(entries) } as unknown as ServiceRegistry
}

export const globalConfig: GlobalConfig = {
  mcp: { host: '127.0.0.1', port: 3333, transport: 'http' },
  auth: { tokenCacheTtlMs: 300_000 },
  sandbox: { memoryLimitMb: 64, executeTimeoutMs: 8000, searchTimeoutMs: 3000, maxApiCalls: 50, maxConcurrentCalls: 5 },
  observability: { logLevel: 'silent' as never, serviceName: 'harbor-gateway', agentName: 'mcp-agent', environment: ENV.DEV, enableAudit: false },
  defaultIdempotency: { type: 'noop' },
  execution: { store: { type: 'in-memory' }, governance: { rulesDir: '/nonexistent', defaultDecision: GOVERNANCE_DECISION.ALLOW, approvalTtlSec: 600 } }
}

export const REQUEST_STATE_KEY = 'test-key-'.repeat(4)

/** `persistence` lets several runtimes share one store — several gateway pods on one shared backend. */
export function makeRuntime(
  rules: Array<Record<string, unknown>> = [],
  defaultDecision: GovernanceDecisionType = GOVERNANCE_DECISION.ALLOW,
  persistence: ExecutionPersistence = new InMemoryExecutionStore(),
  managerOptions: ExecutionManagerOptions = {}
): GovernanceRuntime {
  const manager = new ExecutionManager(persistence, undefined, undefined, managerOptions)
  const approvals = new ApprovalService(persistence, manager)
  const ruleStore = new GovernanceRuleStore()
  ruleStore.swap(rules.map((r, i): LoadedRule => ({ rule: governanceRuleSchema.parse(r), source: `rule-${i}.yaml`, contentHash: 'deadbeefcafe0000' })))
  return {
    persistence, executionManager: manager, approvals, rules: ruleStore,
    requestState: createResumeStateCodec({ key: REQUEST_STATE_KEY, ttlSeconds: 600 }),
    executionConfig: { store: { type: 'in-memory' }, governance: { rulesDir: '/nonexistent', defaultDecision, approvalTtlSec: 600 } },
    async shutdown() {}
  }
}

/** Registers the governed tool and returns its handler. */
export function registerGoverned(governanceRuntime: GovernanceRuntime, resources: ServiceResources): ToolHandler {
  const { handlers, server } = makeFakeServer()
  const metrics = { increment: () => {}, stop: () => {} } as unknown as MetricsRegistry
  registerExecuteApiTool(server, makeRegistry({ [resources.name]: resources }), globalConfig, silentLogger, metrics, 'client-token', governanceRuntime)
  return handlers[TOOL.API_EXECUTE]!
}

export interface FakeCtxOptions {
  elicitation?: boolean
  executionIdMeta?: string
  /** Decoded resume state (what the SDK seam hands the handler after verifying the wire string). */
  state?: ResumeState
  inputResponses?: Record<string, unknown>
  requestId?: string
}

/** A ServerContext as the SDK would present it on the 2026-07-28 path. */
export function makeCtx(opts: FakeCtxOptions = {}): ServerContext {
  const caps = opts.elicitation === false ? {} : { elicitation: { form: {} } }
  return {
    mcpReq: {
      id: opts.requestId ?? '1',
      method: 'tools/call',
      _meta: { ...(opts.executionIdMeta ? { [EXECUTION_ID_META_KEY]: opts.executionIdMeta } : {}) },
      envelope: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': caps
      },
      requestState: () => opts.state,
      ...(opts.inputResponses ? { inputResponses: opts.inputResponses } : {})
    }
  } as unknown as ServerContext
}

/** Simulates the client's retry: verifies the wire requestState like the SDK seam and answers the approval. */
export async function retryCtx(
  governanceRuntime: GovernanceRuntime,
  inputRequiredResult: Record<string, unknown>,
  /** `approve` may be a word ("yes") as well as a boolean — see readApprovalAnswer. */
  answer: { action: 'accept' | 'decline' | 'cancel'; approve?: boolean | string; comment?: string } | undefined,
  requestId = '2'
): Promise<ServerContext> {
  const wire = inputRequiredResult['requestState'] as string
  const state = await governanceRuntime.requestState.verify(wire, makeCtx({ requestId }))
  const inputResponses = answer
    ? { approval: { action: answer.action, ...(answer.action === 'accept' ? { content: { approve: answer.approve ?? true, ...(answer.comment ? { comment: answer.comment } : {}) } } : {}) } }
    : undefined
  return makeCtx({ state, ...(inputResponses ? { inputResponses } : {}), requestId })
}

export function parseContent(result: Record<string, unknown>): unknown {
  const content = result['content'] as Array<{ text: string }>
  return JSON.parse(content[0]!.text)
}
