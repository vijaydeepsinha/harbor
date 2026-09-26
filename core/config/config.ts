// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type {
  GlobalConfig,
  IdempotencyBackendConfig,
  TokenCacheBackendConfig,
  MemcacheConnectionConfig,
  CouchbaseConnectionConfig
} from '../types/config.types.js'
import { LOG_LEVELS } from '../types/config.types.js'
import { STORE_TYPE, ENV, REQUEST_SOURCE_VALUE, MCP_DEFAULT_HOST, MCP_DEFAULT_PORT, EXECUTION_STORE_TYPE, GOVERNANCE_DECISION, GOVERNANCE_RULE_SOURCE_TYPE } from '../constants.js'

// ── Config-file loader ───────────────────────────────────────────────────────
//
// In Kubernetes the ConfigMap is mounted as a file at CONFIG_FILE_DEFAULT_PATH.
// The file contains KEY: "value" lines (simple `KEY: value` format).
// Entries are merged into process.env before Zod validation runs; existing
// vars (e.g. from Secrets injected via envFrom: secretRef:) take precedence.
//
// In local development the file is absent; dotenv/config (called in index.ts)
// populates process.env from .env instead — no extra setup needed.

const CONFIG_FILE_DEFAULT_PATH = '/etc/harbor-config/config.yaml'

function stripQuotes(raw: string): string {
  if (raw.length < 2) return raw
  const first = raw[0]
  const last = raw[raw.length - 1]
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return raw.slice(1, -1)
  }
  return raw
}

function loadConfigFile(): void {
  const filePath = process.env['MCP_CONFIG_FILE'] ?? CONFIG_FILE_DEFAULT_PATH
  let content: string
  try {
    content = readFileSync(filePath, 'utf8')
  } catch {
    return
  }
  const env = process.env
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const sepAt = trimmed.indexOf(':')
    if (sepAt === -1) continue
    const key = trimmed.slice(0, sepAt).trim()
    if (!key || env[key] !== undefined) continue
    env[key] = stripQuotes(trimmed.slice(sepAt + 1).trim())
  }
}

loadConfigFile()

// ── Shared env-var helpers ───────────────────────────────────────────────────

function requireEnvVars(
  env: NodeJS.ProcessEnv,
  specs: Array<{ key: string; label: string }>,
  context: string
): void {
  const errors: string[] = []
  for (const { key, label } of specs) {
    if (!env[key]) errors.push(`${key} (${label}) — required when ${context}`)
  }
  if (errors.length > 0) {
    console.error('Missing required environment variables:\n' + errors.map(e => `  - ${e}`).join('\n'))
    process.exit(1)
  }
}

function parseMemcacheEnv(env: NodeJS.ProcessEnv, prefix: string): MemcacheConnectionConfig {
  return {
    host: env[`${prefix}HOST`]!,
    port: Number(env[`${prefix}PORT`]),
    kvTimeoutMs: Number(env[`${prefix}TIMEOUT_MS`] ?? '2000')
  }
}

function parseCouchbaseEnv(env: NodeJS.ProcessEnv, prefix: string): CouchbaseConnectionConfig {
  return {
    host: env[`${prefix}HOST`]!,
    port: Number(env[`${prefix}PORT`] ?? '8093'),
    bucket: env[`${prefix}BUCKET`]!,
    username: env[`${prefix}USERNAME`]!,
    password: env[`${prefix}PASSWORD`]!,
    kvTimeoutMs: Number(env[`${prefix}TIMEOUT_MS`] ?? '3000')
  }
}

// ── Store type from env (token cache, idempotency — STORE_TYPE discriminant) ──

const MEMCACHE_ENV_SUFFIXES: ReadonlyArray<{ suffix: string; label: string }> = [
  { suffix: 'HOST', label: 'string' },
  { suffix: 'PORT', label: 'number' },
]

const COUCHBASE_ENV_SUFFIXES: ReadonlyArray<{ suffix: string; label: string }> = [
  { suffix: 'HOST', label: 'string' },
  { suffix: 'PORT', label: 'number' },
  { suffix: 'BUCKET', label: 'string' },
  { suffix: 'USERNAME', label: 'string' },
  { suffix: 'PASSWORD', label: 'string' },
]

function prefixedSpecs(prefix: string, suffixes: ReadonlyArray<{ suffix: string; label: string }>) {
  return suffixes.map(({ suffix, label }) => ({ key: `${prefix}${suffix}`, label }))
}

/** Options for resolving a `STORE_TYPE` store from `process.env` plus Memcache/Couchbase connection prefixes. */
interface StoreTypeEnvOptions {
  /** `process.env` key whose value is the store type id (`STORE_TYPE`, e.g. `TOKEN_CACHE_TYPE`, `IDEMPOTENCY_TYPE`). */
  storeTypeEnvKey: string
  defaultType: string
  allowedTypes: readonly [string, ...string[]]
  memcachePrefix: string
  couchbasePrefix: string
}

/**
 * Resolves pluggable store config from an env map (typically `process.env`): validates the `STORE_TYPE`
 * value at `storeTypeEnvKey`, then reads Memcache/Couchbase connection vars when that type is remote.
 * Used for token cache and idempotency backends (same discriminant shape).
 */
function resolveStoreTypeConfig(env: NodeJS.ProcessEnv, opts: StoreTypeEnvOptions) {
  const raw = (env[opts.storeTypeEnvKey] ?? opts.defaultType) as string
  const parsed = z.enum(opts.allowedTypes).safeParse(raw)
  if (!parsed.success) {
    console.error(`${opts.storeTypeEnvKey} must be one of: ${opts.allowedTypes.join(' | ')}. Got: "${raw}"`)
    process.exit(1)
  }

  const type = parsed.data
  switch (type) {
    case STORE_TYPE.MEMCACHE:
      requireEnvVars(
        env,
        prefixedSpecs(opts.memcachePrefix, MEMCACHE_ENV_SUFFIXES),
        `${opts.storeTypeEnvKey}=${type}`
      )
      return { type: STORE_TYPE.MEMCACHE, ...parseMemcacheEnv(env, opts.memcachePrefix) }
    case STORE_TYPE.COUCHBASE:
      requireEnvVars(
        env,
        prefixedSpecs(opts.couchbasePrefix, COUCHBASE_ENV_SUFFIXES),
        `${opts.storeTypeEnvKey}=${type}`
      )
      return { type: STORE_TYPE.COUCHBASE, ...parseCouchbaseEnv(env, opts.couchbasePrefix) }
    default:
      return { type }
  }
}

// ── Global config ────────────────────────────────────────────────────────────

const GlobalConfigSchema = z.object({
  MCP_HOST: z.string().default(MCP_DEFAULT_HOST),
  MCP_PORT: z.coerce.number().int().positive().default(MCP_DEFAULT_PORT),
  MCP_TRANSPORT: z.enum(['http', 'stdio']).default('http'),
  MCP_TOKEN: z.string().optional(),
  AUTH_TOKEN_CACHE_TTL_MS: z.coerce.number().int().positive().default(300_000),
  SANDBOX_MEMORY_MB: z.coerce.number().int().positive().default(64),
  // Wall-clock lifetime for the api_execute sandbox (ms). Covers CPU time
  // AND all awaits (api.request bridge hops). The isolate is forcibly
  // disposed when exhausted.
  SANDBOX_EXECUTE_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  // Wall-clock lifetime for the search_code / discover_skills sandboxes (ms).
  SANDBOX_SEARCH_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  SANDBOX_MAX_API_CALLS: z.coerce.number().int().positive().default(50),
  SANDBOX_MAX_CONCURRENT_CALLS: z.coerce.number().int().positive().default(5),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  SERVICE_NAME: z.string().default('harbor-gateway'),
  MCP_AGENT_NAME: z.string().default(REQUEST_SOURCE_VALUE),
  ENVIRONMENT: z.enum([ENV.DEV, ENV.STAGING, ENV.STAGING_SECONDARY, ENV.CANARY, ENV.PROD]).default(ENV.DEV),
  ENABLE_AUDIT: z.coerce.boolean().default(true),
  HARBOR_RESOURCE_URI: z.string().optional(),
  HARBOR_AUTH_SERVERS: z.string().optional(),
  HARBOR_SCOPES_SUPPORTED: z.string().optional(),
  // ── Code Mode governance layer ──
  EXECUTION_STORE_TYPE: z.enum([EXECUTION_STORE_TYPE.IN_MEMORY, EXECUTION_STORE_TYPE.FILE]).default(EXECUTION_STORE_TYPE.IN_MEMORY),
  EXECUTION_STORE_DIR: z.string().default('./var/executions'),
  GOVERNANCE_RULES_DIR: z.string().default('./governance/rules'),
  // Where rules come from: dir (GOVERNANCE_RULES_DIR), url (GOVERNANCE_RULES_URL), or a registered source type.
  GOVERNANCE_RULES_SOURCE: z.string().min(1).default(GOVERNANCE_RULE_SOURCE_TYPE.DIR),
  GOVERNANCE_RULES_URL: z.string().url().optional(),
  GOVERNANCE_RULES_URL_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  // 0 = load once at boot. A refresh that fails (unreachable, invalid) keeps the last valid rule set.
  GOVERNANCE_RULES_REFRESH_SEC: z.coerce.number().int().min(0).default(0),
  // Fail closed where governance applies: a call some rule targets but none matches is denied.
  // Calls no rule targets are ungoverned and allowed regardless (NO_GOVERNANCE).
  GOVERNANCE_DEFAULT_DECISION: z.enum([GOVERNANCE_DECISION.ALLOW, GOVERNANCE_DECISION.DENY, GOVERNANCE_DECISION.REQUIRE_APPROVAL]).default(GOVERNANCE_DECISION.DENY),
  // HMAC key for the MRTR requestState codec (spec MUST integrity-protect state that drives authorization).
  GOVERNANCE_REQUEST_STATE_KEY: z.string().min(32).optional(),
  GOVERNANCE_APPROVAL_TTL_SEC: z.coerce.number().int().positive().default(600),
})

export function validateGlobalConfig(): GlobalConfig {
  const result = GlobalConfigSchema.safeParse(process.env)
  if (!result.success) {
    const issues = result.error.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`)
    console.error('Configuration validation failed:\n' + issues.join('\n'))
    process.exit(1)
  }

  const env = result.data

  return {
    mcp: {
      host: env.MCP_HOST,
      port: env.MCP_PORT,
      transport: env.MCP_TRANSPORT,
      ...(env.MCP_TOKEN ? { token: env.MCP_TOKEN } : {})
    },
    auth: {
      tokenCacheTtlMs: env.AUTH_TOKEN_CACHE_TTL_MS,
      tokenCacheBackend: resolveStoreTypeConfig(process.env, {
        storeTypeEnvKey: 'TOKEN_CACHE_TYPE',
        defaultType: STORE_TYPE.IN_MEMORY,
        allowedTypes: [STORE_TYPE.IN_MEMORY, STORE_TYPE.MEMCACHE, STORE_TYPE.COUCHBASE],
        memcachePrefix: 'TOKEN_CACHE_MEMCACHE_',
        couchbasePrefix: 'TOKEN_CACHE_CB_',
      }) as TokenCacheBackendConfig
    },
    sandbox: {
      memoryLimitMb: env.SANDBOX_MEMORY_MB,
      executeTimeoutMs: env.SANDBOX_EXECUTE_TIMEOUT_MS,
      searchTimeoutMs: env.SANDBOX_SEARCH_TIMEOUT_MS,
      maxApiCalls: env.SANDBOX_MAX_API_CALLS,
      maxConcurrentCalls: env.SANDBOX_MAX_CONCURRENT_CALLS
    },
    observability: {
      logLevel: env.LOG_LEVEL,
      serviceName: env.SERVICE_NAME,
      agentName: env.MCP_AGENT_NAME,
      environment: env.ENVIRONMENT,
      enableAudit: env.ENABLE_AUDIT
    },
    defaultIdempotency: resolveStoreTypeConfig(process.env, {
      storeTypeEnvKey: 'IDEMPOTENCY_TYPE',
      defaultType: STORE_TYPE.NOOP,
      allowedTypes: [STORE_TYPE.NOOP, STORE_TYPE.IN_MEMORY, STORE_TYPE.MEMCACHE, STORE_TYPE.COUCHBASE],
      memcachePrefix: 'IDEMPOTENCY_MEMCACHE_',
      couchbasePrefix: 'IDEMPOTENCY_CB_',
    }) as IdempotencyBackendConfig,
    codeMode: {
      store: env.EXECUTION_STORE_TYPE === EXECUTION_STORE_TYPE.FILE
        ? { type: EXECUTION_STORE_TYPE.FILE, dir: env.EXECUTION_STORE_DIR }
        : { type: EXECUTION_STORE_TYPE.IN_MEMORY },
      governance: {
        rulesDir: env.GOVERNANCE_RULES_DIR,
        rulesSource: env.GOVERNANCE_RULES_SOURCE,
        ...(env.GOVERNANCE_RULES_URL ? { rulesUrl: env.GOVERNANCE_RULES_URL } : {}),
        rulesUrlTimeoutMs: env.GOVERNANCE_RULES_URL_TIMEOUT_MS,
        rulesRefreshSec: env.GOVERNANCE_RULES_REFRESH_SEC,
        defaultDecision: env.GOVERNANCE_DEFAULT_DECISION,
        ...(env.GOVERNANCE_REQUEST_STATE_KEY ? { requestStateKey: env.GOVERNANCE_REQUEST_STATE_KEY } : {}),
        approvalTtlSec: env.GOVERNANCE_APPROVAL_TTL_SEC
      }
    },
    ...(env.HARBOR_RESOURCE_URI ? {
      oauth: {
        resourceUri: env.HARBOR_RESOURCE_URI,
        authorizationServers: env.HARBOR_AUTH_SERVERS
          ? env.HARBOR_AUTH_SERVERS.split(',').map(s => s.trim()).filter(Boolean)
          : [],
        ...(env.HARBOR_SCOPES_SUPPORTED ? {
          scopesSupported: env.HARBOR_SCOPES_SUPPORTED.split(',').map(s => s.trim()).filter(Boolean)
        } : {})
      }
    } : {})
  }
}
