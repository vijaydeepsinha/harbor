// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * The environment contract of the E2E suite. Tests never hardcode hosts or
 * ports: the orchestrator (`tests/e2e/setup/run-governance.mjs`) sets these
 * for Docker Compose and for local-process mode alike.
 */
export interface E2eEnv {
  /** Main gateway (default ALLOW, file store). */
  mcpBaseUrl: string
  /** Fail-closed gateway (default DENY, 3 s requestState TTL). Absent ⇒ strict tests are skipped with a reason. */
  strictBaseUrl: string | undefined
  /** Mock downstream API (control plane at /__admin/*). */
  mockApiUrl: string
  /** Shell commands the lifecycle tests may run to restart / kill / start the main gateway. */
  restartCmd: string | undefined
  killCmd: string | undefined
  startCmd: string | undefined
  /** Docker image of the gateway (set by the compose orchestrator); used by the boot-refusal test. */
  harborImage: string | undefined
  /** Root of the repository (for the local-process boot-refusal test). */
  repoRoot: string
  artifactsDir: string
  debug: boolean
}

function required(name: string): string {
  const v = process.env[name]
  if (!v) {
    throw new Error(
      `${name} is not set. The governance E2E suite needs a running environment — ` +
      `run "npm run test:governance" (Docker) or "npm run test:governance -- --local", ` +
      `or export ${name} yourself to point at a running gateway.`
    )
  }
  return v
}

const optional = (name: string): string | undefined => process.env[name] || undefined

export const env: E2eEnv = {
  mcpBaseUrl: required('MCP_BASE_URL').replace(/\/+$/, ''),
  strictBaseUrl: optional('MCP_STRICT_BASE_URL')?.replace(/\/+$/, ''),
  mockApiUrl: required('MOCK_API_URL').replace(/\/+$/, ''),
  restartCmd: optional('HARBOR_RESTART_CMD'),
  killCmd: optional('HARBOR_KILL_CMD'),
  startCmd: optional('HARBOR_START_CMD'),
  harborImage: optional('HARBOR_IMAGE'),
  repoRoot: optional('E2E_REPO_ROOT') ?? process.cwd(),
  artifactsDir: optional('E2E_ARTIFACTS_DIR') ?? 'artifacts/e2e',
  debug: process.env['DEBUG_GOVERNANCE'] === 'true'
}

/** Wire constants of the gateway's client-facing contract (deliberately literal — this suite is a black-box client). */
export const WIRE = {
  PROTOCOL_VERSION: '2026-07-28',
  META_PROTOCOL_VERSION: 'io.modelcontextprotocol/protocolVersion',
  META_CLIENT_INFO: 'io.modelcontextprotocol/clientInfo',
  META_CLIENT_CAPABILITIES: 'io.modelcontextprotocol/clientCapabilities',
  META_SERVER_INFO: 'io.modelcontextprotocol/serverInfo',
  META_EXECUTION_ID: 'harbor/execution-id',
  META_EXECUTION_STATUS: 'harbor/execution-status',
  META_APPROVAL_ID: 'harbor/approval-id',
  APPROVAL_INPUT_KEY: 'approval',
  TOOLS: ['discover_services', 'discover_skills', 'get_skill_details', 'search_code', 'api_execute'] as const
} as const

/** Error codes the gateway returns inside `isError` tool results (`src/core/constants.ts ERR`). */
export const ERR = {
  UNKNOWN_SERVICE: 'UNKNOWN_SERVICE',
  API_ERROR: 'API_ERROR',
  CALL_LIMIT_EXCEEDED: 'CALL_LIMIT_EXCEEDED',
  CONCURRENT_LIMIT_EXCEEDED: 'CONCURRENT_LIMIT_EXCEEDED',
  SANDBOX_TIMEOUT: 'SANDBOX_TIMEOUT',
  SANDBOX_SYNTAX: 'SANDBOX_SYNTAX',
  SANDBOX_RUNTIME: 'SANDBOX_RUNTIME',
  INVALID_API_REQUEST: 'INVALID_API_REQUEST',
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
  MISSING_TOKEN: 'MISSING_TOKEN',
  TOKEN_INVALID: 'TOKEN_INVALID'
} as const

export const EXECUTION_STATUS = {
  CREATED: 'CREATED', RUNNING: 'RUNNING', WAITING_APPROVAL: 'WAITING_APPROVAL', INTERRUPTED: 'INTERRUPTED',
  COMPLETED: 'COMPLETED', FAILED: 'FAILED', DENIED: 'DENIED', CANCELLED: 'CANCELLED'
} as const
export const ACTIVITY_STATUS = {
  WAITING_APPROVAL: 'WAITING_APPROVAL', EXECUTING: 'EXECUTING', APPROVED: 'APPROVED', COMPLETED: 'COMPLETED',
  FAILED: 'FAILED', DENIED: 'DENIED', CANCELLED: 'CANCELLED'
} as const
export const APPROVAL_STATUS = { PENDING: 'PENDING', APPROVED: 'APPROVED', REJECTED: 'REJECTED', CANCELLED: 'CANCELLED' } as const
export const DECISION = { ALLOW: 'ALLOW', DENY: 'DENY', REQUIRE_APPROVAL: 'REQUIRE_APPROVAL' } as const
