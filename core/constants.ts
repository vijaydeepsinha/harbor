// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

// ── Deployment environments ──────────────────────────────────────────────────

export const ENV = {
  DEV: 'dev',
  STAGING: 'staging',
  STAGING_SECONDARY: 'staging-secondary',
  CANARY: 'canary',
  PROD: 'prod',
} as const

export type Environment = typeof ENV[keyof typeof ENV]

export const NON_PROD_ENVIRONMENTS = new Set<Environment>([
  ENV.DEV,
  ENV.STAGING,
  ENV.STAGING_SECONDARY,
  ENV.CANARY,
])

// ── Storage type discriminators ──────────────────────────────────────────────
// Used by token cache, idempotency, and config parsing.

export const STORE_TYPE = {
  IN_MEMORY: 'in-memory',
  MEMCACHE: 'memcache',
  COUCHBASE: 'couchbase',
  NOOP: 'noop',
} as const

// ── Auth strategy identifiers ────────────────────────────────────────────────

export const AUTH_TYPE = {
  STATIC_TOKEN: 'static-token',
  OAUTH_INTROSPECTION: 'oauth-introspection',
  JWT_VALIDATION: 'jwt-validation',
  OAUTH_2_1: 'oauth-2.1',
} as const

// ── Circuit breaker strategy identifiers ─────────────────────────────────────

export const CB_TYPE = {
  COUNT_BASED: 'count-based',
  NOOP: 'noop',
} as const

// ── MCP tool identifiers ────────────────────────────────────────────────────

export const TOOL = {
  DISCOVER_SERVICES: 'discover_services',
  DISCOVER_SKILLS: 'discover_skills',
  GET_SKILL_DETAILS: 'get_skill_details',
  SEARCH_CODE: 'search_code',
  API_EXECUTE: 'api_execute',
} as const

// ── Error codes ──────────────────────────────────────────────────────────────

export const ERR = {
  UNKNOWN: 'UNKNOWN',
  UNKNOWN_SERVICE: 'UNKNOWN_SERVICE',
  UNKNOWN_SKILL: 'UNKNOWN_SKILL',
  AUTH_FAILED: 'AUTH_FAILED',
  MISSING_TOKEN: 'MISSING_TOKEN',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  INTROSPECTION_FAILED: 'INTROSPECTION_FAILED',
  API_ERROR: 'API_ERROR',
  CIRCUIT_OPEN: 'CIRCUIT_OPEN',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  CALL_LIMIT_EXCEEDED: 'CALL_LIMIT_EXCEEDED',
  CONCURRENT_LIMIT_EXCEEDED: 'CONCURRENT_LIMIT_EXCEEDED',
  SANDBOX_INTERNAL_ERROR: 'SANDBOX_INTERNAL_ERROR',
  SANDBOX_TIMEOUT: 'SANDBOX_TIMEOUT',
  SANDBOX_MEMORY: 'SANDBOX_MEMORY',
  SANDBOX_SYNTAX: 'SANDBOX_SYNTAX',
  SANDBOX_RUNTIME: 'SANDBOX_RUNTIME',
  INVALID_API_REQUEST: 'INVALID_API_REQUEST',
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL: 'INTERNAL',
} as const

/** Union of every string constant in `ERR`. Use anywhere you were tempted to
 *  type something as `code: string`. */
export type ErrCode = (typeof ERR)[keyof typeof ERR]

/** HTTP methods accepted by `api.request` from sandboxed user code. */
export const ALLOWED_HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
export type AllowedHttpMethod = (typeof ALLOWED_HTTP_METHODS)[number]

// ── HTTP constants ───────────────────────────────────────────────────────────

export const HTTP_HEADER = {
  CONTENT_TYPE: 'Content-Type',
  AUTHORIZATION: 'Authorization',
  CORRELATION_ID: 'X-Correlation-ID',
  REQUEST_SOURCE: 'X-Request-Source',
  SESSION_ID: 'X-MCP-Session-ID',
  MCP_TOOL: 'X-MCP-Tool',
  MCP_SERVICE: 'X-MCP-Service',
  MCP_VERSION: 'X-MCP-Version',
  IDEMPOTENCY_KEY: 'X-Idempotency-Key',
} as const

export const CONTENT_TYPE_JSON = 'application/json'
export const AUTH_SCHEME = 'Bearer'

// ── HTTP gateway surface ─────────────────────────────────────────────────────
// These describe the gateway's own HTTP endpoints and the header the MCP
// Streamable HTTP SDK uses to carry the session id. Kept in one place so the
// gateway, tests, and documentation share a single source of truth.

export const HTTP_ROUTES = {
  HEALTH: '/health',
  MCP: '/mcp',
  OAUTH_PROTECTED_RESOURCE: '/.well-known/oauth-protected-resource',
  OAUTH_PROTECTED_RESOURCE_MCP: '/mcp/.well-known/oauth-protected-resource',
} as const

/** Default bind address and port for the MCP gateway HTTP transport. */
export const MCP_DEFAULT_HOST = '127.0.0.1'
export const MCP_DEFAULT_PORT = 3333

/** Max length for bearer credentials after the `Bearer` prefix (header value hardening). */
export const BEARER_CREDENTIAL_MAX_OCTETS = 8192

/** Minimum octet length for a high-entropy opaque bearer credential (128-bit entropy floor). */
export const BEARER_OPAQUE_MIN_OCTETS = 32

/** Trimmed `Authorization` field value: scheme `AUTH_SCHEME` + one non-whitespace credential only. */
export const REGEXP_BEARER_AUTHORIZATION_FIELD_VALUE = new RegExp(`^${AUTH_SCHEME}\\s+(\\S+)$`, 'i')

/** ASCII C0 controls (excluding TAB/LF/CR) and DEL — rejected inside bearer credentials. */
export const REGEXP_BEARER_CREDENTIAL_CONTROLS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/

/** High-entropy opaque token: base64url chars only, at least BEARER_OPAQUE_MIN_OCTETS long. */
export const REGEXP_OPAQUE_TOKEN_STRONG = new RegExp(`^[A-Za-z0-9_-]{${BEARER_OPAQUE_MIN_OCTETS},}$`)

export const REQUEST_SOURCE_VALUE = 'mcp-agent'
export const MCP_FRAMEWORK_VERSION = '1.0'

// ── Metric names ─────────────────────────────────────────────────────────────

export const METRIC = {
  TOOL_CALLS: 'tool_calls_total',
  SANDBOX_ERRORS: 'sandbox_errors_total',
  CB_OPENS: 'circuit_breaker_opens_total',
  AUTH_CACHE: 'auth_cache_total',
  AUTH_REFRESH_STARTED: 'auth_refresh_started_total',
  AUTH_REFRESH_SUCCEEDED: 'auth_refresh_succeeded_total',
  AUTH_REFRESH_FAILED: 'auth_refresh_failed_total',
  AUTH_REFRESH_SKIPPED: 'auth_refresh_skipped_total',
  AUTH_CACHE_UPDATE_FAILED: 'auth_cache_update_failed_total',
} as const

// ── Structured log prefixes ──────────────────────────────────────────────────

export const LOG_PREFIX = {
  MCP_IN: '[MCP ▶ IN]',
  MCP_OUT: '[MCP ◀ OUT]',
  API_OUT: '[MCP → API]',
  API_IN: '[MCP ← API]',
  MCP: '[MCP]',
} as const

// ── Audit outcome values ─────────────────────────────────────────────────────

export const OUTCOME = {
  SUCCESS: 'success',
  ERROR: 'error',
  CIRCUIT_OPEN: 'circuit_open',
  PERMISSION_DENIED: 'permission_denied',
  CALL_LIMIT_EXCEEDED: 'call_limit_exceeded',
  CONCURRENT_LIMIT_EXCEEDED: 'concurrent_limit_exceeded',
} as const

export type AuditOutcome = typeof OUTCOME[keyof typeof OUTCOME]

// ── Gateway ──────────────────────────────────────────────────────────────────

export const GATEWAY_NAME = 'harbor'
