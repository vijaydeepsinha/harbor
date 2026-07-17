// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { AuthStrategy, TokenCacheStrategy } from './auth.types.js'
import type { CircuitBreakerStrategy } from './circuit-breaker.types.js'
import type { IdempotencyStrategy } from './idempotency.types.js'
import type { PermissionGuard } from './permission.types.js'
import type { SpecLoaderStrategy } from './spec.types.js'
import type { Environment } from '../constants.js'
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

export type ServiceAuthConfig =
  | { type: 'static-token'; token?: string; protocol?: 'http' | 'https'; host?: string; port?: number; introspectionPath?: string; authTimeoutMs?: number; method?: 'GET' | 'POST'; tokenPassMode?: 'query' | 'body' | 'header'; tokenParamName?: string; refreshPath?: string; tokenRefreshBufferSec?: number }
  | { type: 'oauth-introspection'; protocol?: 'http' | 'https'; host: string; port: number; introspectionPath: string; authTimeoutMs?: number; method?: 'GET' | 'POST'; tokenPassMode?: 'query' | 'body' | 'header'; tokenParamName?: string; refreshPath?: string; tokenRefreshBufferSec?: number; responseMapping?: Record<string, string>; metadataMapping?: Record<string, string> }
  | { type: 'jwt-validation'; jwksUri: string; issuer: string; audience?: string; clockToleranceSec?: number; scopeClaim?: string; metadataMapping?: Record<string, string> }
  | { type: 'oauth-2.1'; authorizationServer: string; audience?: string; clockToleranceSec?: number; scopeClaim?: string; metadataMapping?: Record<string, string>; discoveryTimeoutMs?: number }

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
}

export type { AuthStrategy, TokenCacheStrategy, CircuitBreakerStrategy, IdempotencyStrategy, PermissionGuard, SpecLoaderStrategy, OAuthResourceConfig }
