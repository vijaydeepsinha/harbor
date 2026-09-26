// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {
  PROTOCOL_VERSION_META_KEY as SDK_PROTOCOL_VERSION_META_KEY,
  CLIENT_INFO_META_KEY as SDK_CLIENT_INFO_META_KEY,
  CLIENT_CAPABILITIES_META_KEY as SDK_CLIENT_CAPABILITIES_META_KEY,
  SERVER_INFO_META_KEY as SDK_SERVER_INFO_META_KEY
} from '@modelcontextprotocol/server'

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
  // ── Code Mode governance layer ──
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  GOVERNANCE_DENIED: 'GOVERNANCE_DENIED',
  REPLAY_DIVERGED: 'REPLAY_DIVERGED',
  EXECUTION_LOCKED: 'EXECUTION_LOCKED',
  EXECUTION_NOT_FOUND: 'EXECUTION_NOT_FOUND',
  EXECUTION_NOT_RESUMABLE: 'EXECUTION_NOT_RESUMABLE',
  EXECUTION_CANCELLED: 'EXECUTION_CANCELLED',
  ACTIVITY_OUTCOME_UNKNOWN: 'ACTIVITY_OUTCOME_UNKNOWN',
  APPROVAL_NOT_FOUND: 'APPROVAL_NOT_FOUND',
  APPROVAL_ALREADY_DECIDED: 'APPROVAL_ALREADY_DECIDED',
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
  /** MCP 2026-07-28 protocol headers (spec §13/§14). Validated by the SDK;
   *  Harbor only reads them for routing/authorization/observability. */
  MCP_PROTOCOL_VERSION: 'MCP-Protocol-Version',
  MCP_METHOD: 'Mcp-Method',
  MCP_NAME: 'Mcp-Name',
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
  /** Code Mode execution inspection + fallback approval decisions (see docs/code-mode-governance.md). */
  EXECUTIONS: '/executions',
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
  APPROVAL_REQUIRED: 'approval_required',
  GOVERNANCE_DENIED: 'governance_denied',
  REPLAY_DIVERGED: 'replay_diverged',
  EXECUTION_CANCELLED: 'execution_cancelled',
} as const

export type AuditOutcome = typeof OUTCOME[keyof typeof OUTCOME]

// ── Gateway ──────────────────────────────────────────────────────────────────

export const GATEWAY_NAME = 'harbor'

/** Advertised gateway (MCP server) version. Surfaced through response
 *  `_meta` serverInfo and the `McpServer` implementation identity. */
export const GATEWAY_VERSION = '1.0.0'

// ── MCP 2026-07-28 reserved `_meta` namespace ─────────────────────────────────
// Keys in the `io.modelcontextprotocol/*` namespace are protocol-defined and
// carried out-of-band from model-visible `content`. Harbor treats inbound
// values as untrusted (never for auth/security) and only *emits* serverInfo.

/**
 * Response `_meta` key carrying server identity (spec §10). Recommended
 * (SHOULD, not mandatory). Re-exported from the SDK's own reserved-key
 * constant so Harbor and the SDK cannot silently drift on this string.
 */
export const SERVER_INFO_META_KEY = SDK_SERVER_INFO_META_KEY

/**
 * Request `_meta` key carrying the negotiated protocol version (spec §9).
 * Re-exported from the SDK's own reserved-key constant so Harbor and the SDK
 * cannot silently drift on this string.
 */
export const PROTOCOL_VERSION_META_KEY = SDK_PROTOCOL_VERSION_META_KEY

/**
 * Request `_meta` key carrying client implementation info (spec §9).
 * Re-exported from the SDK's own reserved-key constant.
 */
export const CLIENT_INFO_META_KEY = SDK_CLIENT_INFO_META_KEY

/**
 * Request `_meta` key carrying client capabilities (spec §9).
 * Re-exported from the SDK's own reserved-key constant.
 */
export const CLIENT_CAPABILITIES_META_KEY = SDK_CLIENT_CAPABILITIES_META_KEY

/** The single MCP protocol version this gateway speaks (spec §20). */
export const MCP_PROTOCOL_VERSION = '2026-07-28'

// ── Code Mode governance layer ───────────────────────────────────────────────
// Vocabulary shared by the execution store, the sandbox bridge, the governance
// evaluator and the api_execute tool. Kept here (not in the types module) so
// runtime switch statements and tests reference one spelling.

/**
 * Harbor's own `_meta` namespace. MCP 2026-07-28 asks third parties to prefix
 * custom keys with a vendor label (reverse-DNS preferred); the prefix must not
 * have `mcp` / `modelcontextprotocol` as its second label. `harbor/` is a
 * placeholder until the project's public name is settled — rename in one place.
 */
export const META_PREFIX = 'harbor/'
/** Response `_meta`: the durable execution id of the Code Mode run. Request `_meta`: resume this execution (non-MRTR clients). */
export const EXECUTION_ID_META_KEY = `${META_PREFIX}execution-id`
/** Response `_meta`: execution status after this tool call. */
export const EXECUTION_STATUS_META_KEY = `${META_PREFIX}execution-status`
/** Response `_meta`: the approval the execution is waiting on (fallback path). */
export const APPROVAL_ID_META_KEY = `${META_PREFIX}approval-id`

/** Key of the embedded elicitation inside an `input_required` result. */
export const APPROVAL_INPUT_KEY = 'approval'

export const EXECUTION_STATUS = {
  CREATED: 'CREATED',
  RUNNING: 'RUNNING',
  WAITING_APPROVAL: 'WAITING_APPROVAL',
  /** A run ended on a retryable error (circuit open, timeout, transport) before completing; resumable. */
  INTERRUPTED: 'INTERRUPTED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  DENIED: 'DENIED',
  CANCELLED: 'CANCELLED',
} as const
export type ExecutionStatus = (typeof EXECUTION_STATUS)[keyof typeof EXECUTION_STATUS]

export const ACTIVITY_STATUS = {
  /** Governance said REQUIRE_APPROVAL; no human decision yet. */
  WAITING_APPROVAL: 'WAITING_APPROVAL',
  /** The external call is in flight. Found on resume ⇒ the process died mid-call: safe methods re-execute, others fail closed. */
  EXECUTING: 'EXECUTING',
  /** Approved by a human; the external call has not been made yet. */
  APPROVED: 'APPROVED',
  /** External call made and a response (any HTTP status) recorded — replayable. */
  COMPLETED: 'COMPLETED',
  /** The transport threw: Harbor does not know whether the API executed. Never replayed, never retried silently. */
  FAILED: 'FAILED',
  /** Governance DENY, or a human rejected the approval. */
  DENIED: 'DENIED',
  /** A human cancelled the approval. */
  CANCELLED: 'CANCELLED',
} as const
export type ActivityStatus = (typeof ACTIVITY_STATUS)[keyof typeof ACTIVITY_STATUS]

export const GOVERNANCE_DECISION = {
  ALLOW: 'ALLOW',
  DENY: 'DENY',
  REQUIRE_APPROVAL: 'REQUIRE_APPROVAL',
} as const
export type GovernanceDecisionType = (typeof GOVERNANCE_DECISION)[keyof typeof GOVERNANCE_DECISION]

/** Precedence among matched rules of the deciding level (higher wins). Documented in docs/code-mode-governance.md. */
export const GOVERNANCE_PRECEDENCE: Record<GovernanceDecisionType, number> = {
  [GOVERNANCE_DECISION.DENY]: 3,
  [GOVERNANCE_DECISION.REQUIRE_APPROVAL]: 2,
  [GOVERNANCE_DECISION.ALLOW]: 1,
}

/**
 * How broadly a Governance Rule applies, derived from what its `match` names:
 * an operation or path ⇒ endpoint; a service only ⇒ service; neither ⇒
 * gateway. The most specific level with a matching rule decides, unless a
 * broader matching rule is `final`.
 */
export const RULE_LEVEL = {
  GATEWAY: 'gateway',
  SERVICE: 'service',
  ENDPOINT: 'endpoint',
} as const
export type RuleLevel = (typeof RULE_LEVEL)[keyof typeof RULE_LEVEL]

/** Specificity of each level (higher is more specific). */
export const RULE_LEVEL_SPECIFICITY: Record<RuleLevel, number> = {
  [RULE_LEVEL.GATEWAY]: 1,
  [RULE_LEVEL.SERVICE]: 2,
  [RULE_LEVEL.ENDPOINT]: 3,
}

export const APPROVAL_STATUS = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
} as const
export type ApprovalStatus = (typeof APPROVAL_STATUS)[keyof typeof APPROVAL_STATUS]

export const EXECUTION_STORE_TYPE = {
  IN_MEMORY: 'in-memory',
  FILE: 'file',
  /** Shared across pods: executions, journal, approvals and the run lock live in memcache. */
  MEMCACHE: 'memcache',
} as const

/**
 * What happens to an execution's program text once it is terminal
 * (`EXECUTION_CODE_RETENTION`). The code is needed only to resume, and a
 * terminal execution never resumes.
 */
export const EXECUTION_CODE_RETENTION = {
  /** Remove it from the execution record (default). */
  DROP: 'DROP',
  /** Keep it stored against the executionId. */
  KEEP: 'KEEP',
} as const
export type ExecutionCodeRetention = (typeof EXECUTION_CODE_RETENTION)[keyof typeof EXECUTION_CODE_RETENTION]

/** Built-in Governance Rule sources (`GOVERNANCE_RULES_SOURCE`); others via registerGovernanceRuleSourceBackend. */
export const GOVERNANCE_RULE_SOURCE_TYPE = {
  DIR: 'dir',
  URL: 'url',
} as const

/** Reason codes attached to governance decisions and execution failures. */
export const GOVERNANCE_REASON = {
  /** Some rule targets the call, none matched ⇒ the configured default decision. */
  NO_MATCHING_RULE: 'NO_MATCHING_RULE',
  /** No rule targets the call at all ⇒ it is ungoverned and allowed. */
  NO_GOVERNANCE: 'NO_GOVERNANCE',
  RULE_MATCHED: 'RULE_MATCHED',
  EVALUATION_FAILED: 'GOVERNANCE_EVALUATION_FAILED',
  APPROVAL_REJECTED: 'APPROVAL_REJECTED',
  APPROVAL_CANCELLED: 'APPROVAL_CANCELLED',
} as const
