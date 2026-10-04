// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type {Environment, ExecutionCodeRetention, GovernanceDecisionType} from '../constants.js'
import type {OAuthResourceConfig} from './oauth.types.js'

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
    | ({ type: 'memcache'; keyPrefix?: string; lockTtlSec?: number } & MemcacheConnectionConfig)

/** Per-service source and refresh settings for Governance Rules. */
export interface GovernanceRuleSourceConfig {
    /** Absolute path after service config resolution. */
    rulesDir: string
    /** `file` (default), `url`, or a registered source type. */
    rulesSource: string
    rulesUrl?: string
    rulesUrlTimeoutMs: number
    /** Seconds; 0 disables periodic refresh. */
    rulesRefreshSec: number
}

/** Durable execution settings, including governance (see docs/code-mode-governance.md). */
export interface ExecutionConfig {
    store: ExecutionStoreBackendConfig
    /** What is kept once an execution is terminal. */
    retention?: {
        /** `DROP` (default) removes the program text; `KEEP` keeps it against the executionId. */
        code?: ExecutionCodeRetention
        /** Seconds after it finished that a terminal execution and all its records are deleted; 0 / absent ⇒ kept. */
        executionSec?: number
    }
    governance: {
        /** Gateway-owned file rule directory; shared across every enabled service. */
        gatewayRulesDir?: string
        /** Seconds between gateway-owned rule refreshes; 0 loads once. */
        gatewayRulesRefreshSec?: number
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
    | {
    type: 'static-token';
    token?: string;
    protocol?: 'http' | 'https';
    host?: string;
    port?: number;
    introspectionPath?: string;
    authTimeoutMs?: number;
    method?: 'GET' | 'POST';
    tokenPassMode?: 'query' | 'body' | 'header';
    tokenParamName?: string;
    refreshPath?: string;
    tokenRefreshBufferSec?: number
}
    | {
    type: 'oauth-introspection';
    protocol?: 'http' | 'https';
    host: string;
    port: number;
    introspectionPath: string;
    authTimeoutMs?: number;
    method?: 'GET' | 'POST';
    tokenPassMode?: 'query' | 'body' | 'header';
    tokenParamName?: string;
    refreshPath?: string;
    tokenRefreshBufferSec?: number;
    responseMapping?: Record<string, string>;
    metadataMapping?: Record<string, string>;
    audience?: string
}
    | {
    type: 'jwt-validation';
    jwksUri: string;
    issuer: string;
    audience: string;
    clockToleranceSec?: number;
    scopeClaim?: string;
    metadataMapping?: Record<string, string>
}
    | {
    type: 'oauth-2.1';
    authorizationServer: string;
    audience: string;
    clockToleranceSec?: number;
    scopeClaim?: string;
    metadataMapping?: Record<string, string>;
    discoveryTimeoutMs?: number
}

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
        /** Largest `/mcp` request body read before a 413 (MCP_MAX_BODY_BYTES). Absent ⇒ MCP_DEFAULT_MAX_BODY_BYTES. */
        maxBodyBytes?: number
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
        /** Audit sinks every event goes to (AUDIT_SINKS): `console` (built in) or registered types. Absent ⇒ `['console']`. */
        auditSinks?: string[]
        /** Sent as X-Harbor-Server-ID on every backend call (HARBOR_SERVER_ID). Absent ⇒ `HARBOR_GATEWAY`. */
        serverId?: string
    }
    defaultIdempotency: IdempotencyBackendConfig
    oauth?: OAuthResourceConfig
    /** Durable execution settings. */
    execution: ExecutionConfig
}

export type {OAuthResourceConfig}
