// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { AuthStrategy, TokenCacheStrategy } from './auth.types.js'
import type { CircuitBreakerStrategy } from './circuit-breaker.types.js'
import type { IdempotencyStrategy } from './idempotency.types.js'
import type { PermissionGuard } from './permission.types.js'
import type { SpecLoaderStrategy } from './spec.types.js'
import type { Environment, GovernanceDecisionType, ExecutionCodeRetention } from '../constants.js'
import type { OAuthResourceConfig } from './oauth.types.js'

/** Pino log levels. Narrowed from `string` so typos are caught at compile time. */
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

export interface MemcacheConnectionConfig {
  host: string
  port: number
  kvTimeoutMs: number
}

export interface CouchbaseConnectionConfig {
  host: string
  port: number
  bucket: string
  username: string
  password: string
  kvTimeoutMs: number
}

export type TokenCacheBackendConfig =
  | { type: 'in-memory' }
  | ({ type: 'memcache' } & MemcacheConnectionConfig)
  | ({ type: 'couchbase' } & CouchbaseConnectionConfig)

export type IdempotencyBackendConfig =
  | { type: 'noop' }
  | { type: 'in-memory' }
  | ({ type: 'memcache' } & MemcacheConnectionConfig)
  | ({ type: 'couchbase' } & CouchbaseConnectionConfig)

export type ExecutionStoreBackendConfig =
  | { type: 'in-memory' }
  | { type: 'file'; dir: string }

/** Code Mode governance layer settings (see docs/code-mode-governance.md). */
export interface CodeModeConfig {
  store: ExecutionStoreBackendConfig
  /** What is kept once an execution is terminal. */
  retention?: {
    /** `DROP` (default) removes the program text; `KEEP` keeps it against the executionId. */
    code?: ExecutionCodeRetention
  }
  governance: {
    /** Directory of Governance Rule files (`*.yaml` / `*.yml` / `*.json`) for the `dir` source. Missing dir ⇒ no rules. */
    rulesDir: string
    /** Where rules come from: `dir` (default), `url`, or a type registered with registerGovernanceRuleSourceBackend. */
    rulesSource?: string
    /** Rule document URL for the `url` source. */
    rulesUrl?: string
    /** Fetch timeout for the `url` source. */
    rulesUrlTimeoutMs?: number
    /** Re-read the source every N seconds (0 / absent ⇒ load once at boot). A failed refresh keeps the last valid set. */
    rulesRefreshSec?: number
    /**
     * Decision for a call that some rule targets (its `match` fits) but no rule
     * matches. A call no rule targets is ungoverned and always allowed
     * (`NO_GOVERNANCE`), so deployments without rules behave as before.
     */
    defaultDecision: GovernanceDecisionType
    /** HMAC key for MRTR `requestState`; ≥32 chars. Absent ⇒ a per-process random key (single-instance only). */
    requestStateKey?: string
    /** How long a paused execution's `requestState` stays redeemable. */
    approvalTtlSec: number
  }
}

export type ServiceAuthConfig =
  | { type: 'static-token'; token?: string; protocol?: 'http' | 'https'; host?: string; port?: number; introspectionPath?: string; authTimeoutMs?: number; method?: 'GET' | 'POST'; tokenPassMode?: 'query' | 'body' | 'header'; tokenParamName?: string; refreshPath?: string; tokenRefreshBufferSec?: number }
  | { type: 'oauth-introspection'; protocol?: 'http' | 'https'; host: string; port: number; introspectionPath: string; authTimeoutMs?: number; method?: 'GET' | 'POST'; tokenPassMode?: 'query' | 'body' | 'header'; tokenParamName?: string; refreshPath?: string; tokenRefreshBufferSec?: number; responseMapping?: Record<string, string>; metadataMapping?: Record<string, string>; audience?: string }
  | { type: 'jwt-validation'; jwksUri: string; issuer: string; audience: string; clockToleranceSec?: number; scopeClaim?: string; metadataMapping?: Record<string, string> }
  | { type: 'oauth-2.1'; authorizationServer: string; audience: string; clockToleranceSec?: number; scopeClaim?: string; metadataMapping?: Record<string, string>; discoveryTimeoutMs?: number }

export type ServiceCircuitBreakerConfig =
  | { type: 'noop' }
  | { type: 'count-based'; failureThreshold: number; recoveryTimeMs: number }

/**
 * Sandbox resource limits. Per-service config.json may override via SandboxOverride;
 * server-factory merges override ∪ global defaults before handing to sandboxes.
 * executeTimeoutMs / searchTimeoutMs are WALL-CLOCK (CPU + awaits).
 */
export interface SandboxLimits {
  memoryLimitMb: number
  executeTimeoutMs: number
  searchTimeoutMs: number
  maxApiCalls: number
  maxConcurrentCalls: number
}

export type SandboxOverride = Partial<SandboxLimits>

export interface GlobalConfig {
  mcp: {
    host: string
    port: number
    transport: 'http' | 'stdio'
    /** Static bearer used by the stdio transport. Required when transport === 'stdio'. */
    token?: string
  }
  auth: {
    tokenCacheTtlMs: number
    tokenCacheBackend?: TokenCacheBackendConfig
  }
  sandbox: SandboxLimits
  observability: {
    logLevel: LogLevel
    serviceName: string
    agentName: string
    environment: Environment
    enableAudit: boolean
  }
  defaultIdempotency: IdempotencyBackendConfig
  oauth?: OAuthResourceConfig
  codeMode: CodeModeConfig
}

export type { AuthStrategy, TokenCacheStrategy, CircuitBreakerStrategy, IdempotencyStrategy, PermissionGuard, SpecLoaderStrategy, OAuthResourceConfig }
