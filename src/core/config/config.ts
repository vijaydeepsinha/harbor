// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type {
  GlobalConfig,
  ExecutionStoreBackendConfig,
  IdempotencyBackendConfig,
  TokenCacheBackendConfig,
  MemcacheConnectionConfig,
  CouchbaseConnectionConfig
} from '../types/config.types.js'
import { LOG_LEVELS } from '../types/config.types.js'
import { SAFE_HEADER_VALUE } from '../utils/header-value.js'
import { STORE_TYPE, ENV, REQUEST_SOURCE_VALUE, DEFAULT_HARBOR_SERVER_ID, MCP_DEFAULT_HOST, MCP_DEFAULT_PORT, MCP_DEFAULT_MAX_BODY_BYTES, EXECUTION_STORE_TYPE, EXECUTION_CODE_RETENTION, GOVERNANCE_DECISION, GOVERNANCE_RULE_SOURCE_TYPE } from '../constants.js'

/**
 * `<install root>/governance/rules`: three levels up from both
 * src/core/config/config.ts and dist/core/config/config.js — the same root
 * SERVICES_DIR defaults to, so the rules are found whatever the working
 * directory the gateway was started from.
 */
export const DEFAULT_GOVERNANCE_RULES_DIR = fileURLToPath(new URL('../../../governance/rules', import.meta.url))

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

/**
 * A positive integer from the environment (a port stays ≤ 65535). `Number()`
 * alone turned "abc" into NaN — a NaN port or a NaN/1000 client timeout —
 * and accepted 0 and negatives, so every cache or store call failed later
 * instead of the gateway refusing to start.
 */
function positiveIntEnv(env: NodeJS.ProcessEnv, key: string, fallback?: string, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[key] ?? fallback
  const n = Number(raw)
  if (raw === undefined || raw.trim() === '' || !Number.isInteger(n) || n <= 0 || n > max) {
    console.error(`Configuration validation failed:\n  - ${key}: expected a positive integer${max < Number.MAX_SAFE_INTEGER ? ` ≤ ${max}` : ''}, got "${raw ?? ''}"`)
    process.exit(1)
  }
  return n
}

const MAX_PORT = 65_535

function parseMemcacheEnv(env: NodeJS.ProcessEnv, prefix: string): MemcacheConnectionConfig {
  return {
    host: env[`${prefix}HOST`]!,
    port: positiveIntEnv(env, `${prefix}PORT`, undefined, MAX_PORT),
    kvTimeoutMs: positiveIntEnv(env, `${prefix}TIMEOUT_MS`, '2000')
  }
}

function parseCouchbaseEnv(env: NodeJS.ProcessEnv, prefix: string): CouchbaseConnectionConfig {
  return {
    host: env[`${prefix}HOST`]!,
    port: positiveIntEnv(env, `${prefix}PORT`, '8093', MAX_PORT),
    bucket: env[`${prefix}BUCKET`]!,
    username: env[`${prefix}USERNAME`]!,
    password: env[`${prefix}PASSWORD`]!,
    kvTimeoutMs: positiveIntEnv(env, `${prefix}TIMEOUT_MS`, '3000')
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
/** How a registered backend may be named: kebab-case, like the built-in ones. */
const REGISTERED_TYPE_NAME = /^[a-z][a-z0-9-]*$/

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
  // A built-in type, or the name of a backend registered in code
  // (registerTokenCacheBackend / registerIdempotencyBackend). The builder
  // resolves the latter and refuses a name nothing registered — a closed enum
  // here made the documented "register it, then set the env var" impossible.
  if (!(opts.allowedTypes as readonly string[]).includes(raw) && !REGISTERED_TYPE_NAME.test(raw)) {
    console.error(`${opts.storeTypeEnvKey} must be one of: ${opts.allowedTypes.join(' | ')}, or the name of a registered backend. Got: "${raw}"`)
    process.exit(1)
  }

  const type = raw
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
  MCP_MAX_BODY_BYTES: z.coerce.number().int().positive().default(MCP_DEFAULT_MAX_BODY_BYTES),
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
  // Harbor's stamp on every backend call (X-Harbor-Server-ID): printable ASCII, ≤128 characters.
  HARBOR_SERVER_ID: z.string().regex(SAFE_HEADER_VALUE, 'printable ASCII, 1–128 characters, no leading/trailing space').default(DEFAULT_HARBOR_SERVER_ID),
  ENVIRONMENT: z.enum([ENV.DEV, ENV.STAGING, ENV.STAGING_SECONDARY, ENV.CANARY, ENV.PROD]).default(ENV.DEV),
  // z.coerce.boolean() would read the string "false" (any non-empty string) as true.
  ENABLE_AUDIT: z.enum(['true', 'false', '1', '0']).default('true').transform(v => v === 'true' || v === '1'),
  // Where audit records and execution-state events go: comma list of `console` (built in) or registered sink types.
  AUDIT_SINKS: z.string().default('console'),
  HARBOR_RESOURCE_URI: z.string().optional(),
  HARBOR_AUTH_SERVERS: z.string().optional(),
  HARBOR_SCOPES_SUPPORTED: z.string().optional(),
  // ── Code Mode governance layer ──
  // in-memory | file | memcache, or the name of a backend registered with registerExecutionStoreBackend.
  EXECUTION_STORE_TYPE: z.string().regex(REGISTERED_TYPE_NAME, 'a store type name (in-memory, file, memcache, or a registered backend)').default(EXECUTION_STORE_TYPE.IN_MEMORY),
  // memcache store only (EXECUTION_STORE_MEMCACHE_HOST / _PORT are required with it, _TIMEOUT_MS optional — same shape as TOKEN_CACHE_MEMCACHE_*).
  EXECUTION_STORE_MEMCACHE_KEY_PREFIX: z.string().min(1).optional(),
  // Must exceed the longest sandbox run: a crashed pod's run lock is released only when this expires.
  EXECUTION_STORE_MEMCACHE_LOCK_TTL_SEC: z.coerce.number().int().positive().optional(),
  EXECUTION_STORE_DIR: z.string().default('./var/executions'),
  // DROP (default): a terminal execution's program text is removed; KEEP: it stays stored against the executionId.
  EXECUTION_CODE_RETENTION: z.enum([EXECUTION_CODE_RETENTION.DROP, EXECUTION_CODE_RETENTION.KEEP]).default(EXECUTION_CODE_RETENTION.DROP),
  // Seconds a finished (terminal) execution and all its records are kept before deletion; 0 = keep forever.
  EXECUTION_RETENTION_SEC: z.coerce.number().int().min(0).default(86_400),
  // Unset ⇒ <install root>/governance/rules, like SERVICES_DIR (see DEFAULT_GOVERNANCE_RULES_DIR); a set value is relative to the working directory.
  GOVERNANCE_RULES_DIR: z.string().min(1).optional(),
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
}).superRefine((env, ctx) => {
  // Audit on with no destination would drop every record while the switch says it is on.
  if (env.ENABLE_AUDIT && env.AUDIT_SINKS.split(',').every(sink => sink.trim() === '')) {
    ctx.addIssue({ code: 'custom', path: ['AUDIT_SINKS'], message: 'names no sink while ENABLE_AUDIT is on — set a sink (e.g. console) or ENABLE_AUDIT=false' })
  }
})

/** EXECUTION_STORE_TYPE → the store config; memcache connection vars are required like the token cache's. */
function resolveExecutionStoreConfig(env: z.infer<typeof GlobalConfigSchema>): ExecutionStoreBackendConfig {
  switch (env.EXECUTION_STORE_TYPE) {
    case EXECUTION_STORE_TYPE.FILE:
      return { type: EXECUTION_STORE_TYPE.FILE, dir: env.EXECUTION_STORE_DIR }
    case EXECUTION_STORE_TYPE.MEMCACHE:
      requireEnvVars(
        process.env,
        prefixedSpecs('EXECUTION_STORE_MEMCACHE_', MEMCACHE_ENV_SUFFIXES),
        `EXECUTION_STORE_TYPE=${EXECUTION_STORE_TYPE.MEMCACHE}`
      )
      return {
        type: EXECUTION_STORE_TYPE.MEMCACHE,
        ...parseMemcacheEnv(process.env, 'EXECUTION_STORE_MEMCACHE_'),
        ...(env.EXECUTION_STORE_MEMCACHE_KEY_PREFIX ? { keyPrefix: env.EXECUTION_STORE_MEMCACHE_KEY_PREFIX } : {}),
        ...(env.EXECUTION_STORE_MEMCACHE_LOCK_TTL_SEC ? { lockTtlSec: env.EXECUTION_STORE_MEMCACHE_LOCK_TTL_SEC } : {})
      }
    case EXECUTION_STORE_TYPE.IN_MEMORY:
      return { type: EXECUTION_STORE_TYPE.IN_MEMORY }
    default:
      // A registered backend: buildExecutionStore resolves it, or refuses an unknown name at boot.
      return { type: env.EXECUTION_STORE_TYPE } as unknown as ExecutionStoreBackendConfig
  }
}

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
      maxBodyBytes: env.MCP_MAX_BODY_BYTES,
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
      enableAudit: env.ENABLE_AUDIT,
      auditSinks: env.AUDIT_SINKS.split(',').map(s => s.trim()).filter(Boolean),
      serverId: env.HARBOR_SERVER_ID
    },
    defaultIdempotency: resolveStoreTypeConfig(process.env, {
      storeTypeEnvKey: 'IDEMPOTENCY_TYPE',
      defaultType: STORE_TYPE.NOOP,
      allowedTypes: [STORE_TYPE.NOOP, STORE_TYPE.IN_MEMORY, STORE_TYPE.MEMCACHE, STORE_TYPE.COUCHBASE],
      memcachePrefix: 'IDEMPOTENCY_MEMCACHE_',
      couchbasePrefix: 'IDEMPOTENCY_CB_',
    }) as IdempotencyBackendConfig,
    codeMode: {
      store: resolveExecutionStoreConfig(env),
      retention: { code: env.EXECUTION_CODE_RETENTION, executionSec: env.EXECUTION_RETENTION_SEC },
      governance: {
        rulesDir: env.GOVERNANCE_RULES_DIR ?? DEFAULT_GOVERNANCE_RULES_DIR,
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
