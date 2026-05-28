// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import matter from 'gray-matter'
import SwaggerParser from '@apidevtools/swagger-parser'
import type { OpenAPISpec } from '../../core/types/spec.types.js'
import type { AuthStrategy } from '../../core/types/auth.types.js'
import type { CircuitBreakerStrategy } from '../../core/types/circuit-breaker.types.js'
import type { IdempotencyBackendConfig, SandboxOverride, ServiceAuthConfig, ServiceCircuitBreakerConfig } from '../../core/types/config.types.js'
import type { PermissionGuard } from '../../core/types/permission.types.js'
import { forwardTokenPermissionGuard } from '../../spi/permissions/strategies/forward-token-permission-guard.strategy.js'
import type { Logger } from '../observability/logger.js'
import { STORE_TYPE } from '../../core/constants.js'
import { errorMessage } from '../../core/utils/errors.js'
import { resolveAuth, resolveCircuitBreaker } from '../../wiring/service-wiring.js'

// ── Types ────────────────────────────────────────────────────────────────────

interface ServiceConfig {
  enabled?: boolean
  description?: string
  api?: {
    protocol?: 'http' | 'https'
    host?: string
    port?: number
    basePath?: string
    requestTimeoutMs?: number
    maxRetries?: number
    tls?: {
      certPath: string
      keyPath: string
      caPath: string
    }
  }
  auth?: ServiceAuthConfig
  circuitBreaker?: ServiceCircuitBreakerConfig
  idempotency?: {
    type: 'noop' | 'in-memory' | 'memcache' | 'couchbase'
    idempotencyKeyTtlMs?: number
    [key: string]: unknown
  }
  spec?: {
    source?: 'file' | 'url' | 'url-with-fallback'
    url?: string
  }
  serviceRefreshIntervalMs?: number
  serviceRefreshTimeoutMs?: number
  sandbox?: SandboxOverride
}

export interface SkillMetadata {
  id: string
  filename: string
  title: string
  tags: string[]
  content: string
}

export interface ServiceDefinition {
  name: string
  description: string
  serviceDir: string
  spec: OpenAPISpec
  specPath: string
  specSource: {
    type: 'file' | 'url' | 'url-with-fallback'
    url?: string
  }
  serviceRefreshIntervalMs: number
  serviceRefreshTimeoutMs: number
  skills: SkillMetadata[]
  apiConfig: {
    protocol: 'http' | 'https'
    host: string
    port: number
    basePath: string
    requestTimeoutMs: number
    maxRetries: number
    tls?: {
      certPath: string
      keyPath: string
      caPath: string
    }
  }
  auth: AuthStrategy
  circuitBreaker: CircuitBreakerStrategy
  permissionGuard: PermissionGuard
  idempotencyBackend: IdempotencyBackendConfig
  idempotencyKeyTtlMs: number
  sandboxOverride: SandboxOverride
}

/**
 * Scans a directory for service subdirectories. Each subdirectory that contains
 * a spec file (spec.json or spec.yaml) is treated as a service.
 */
export async function scanServicesDirectory(
  servicesDir: string,
  logger: Logger
): Promise<ServiceDefinition[]> {
  if (!existsSync(servicesDir)) {
    logger.warn({ servicesDir }, 'Services directory does not exist — no services will be loaded')
    return []
  }

  const entries = readdirSync(servicesDir)
  const scannedServices: ServiceDefinition[] = []

  for (const entry of entries) {
    const serviceDir = join(servicesDir, entry)
    if (!statSync(serviceDir).isDirectory()) continue

    try {
      const service = await scanSingleService(serviceDir, entry, logger)
      if (!service) continue
      scannedServices.push(service)
      logger.info(
        { service: entry, skills: service.skills.length, specPath: service.specPath },
        `Scanned service "${entry}"`
      )
    } catch (err) {
      const msg = errorMessage(err)
      logger.error({ service: entry, error: msg }, `Failed to scan service "${entry}" — skipping`)
    }
  }

  return scannedServices
}

async function scanSingleService(
  serviceDir: string,
  name: string,
  logger: Logger
): Promise<ServiceDefinition | null> {
  // ── 1. Load config.json (optional — defaults for everything) ─────────────
  const configPath = join(serviceDir, 'config.json')
  let config: ServiceConfig = {}
  if (existsSync(configPath)) {
    config = JSON.parse(readFileSync(configPath, 'utf-8')) as ServiceConfig
  } else {
    logger.info({ service: name }, 'No config.json found — using defaults')
  }

  // ── 2. Check enabled flag — skip before expensive spec parse ─────────────
  if (config.enabled === false) {
    logger.info({ service: name }, `Service "${name}" is disabled — skipping`)
    return null
  }

  // ── 3. Find and load spec ────────────────────────────────────────────────
  const specPath = findSpecFile(serviceDir)
  if (!specPath) {
    throw new Error(`No spec.json or spec.yaml found in ${serviceDir}`)
  }

  const rawSpec = await SwaggerParser.dereference(specPath)
  const spec = rawSpec as unknown as OpenAPISpec

  // ── 4. Derive API host/port from config or spec's servers field ──────────
  const apiConfig = resolveApiConfig(config, spec, name, logger)

  // ── 5. Build strategies from config ──────────────────────────────────────
  const auth = resolveAuth(config.auth, logger)
  const circuitBreaker = resolveCircuitBreaker(config.circuitBreaker)
  const permissionGuard = forwardTokenPermissionGuard()
  const idempotencyBackend = resolveIdempotencyBackend(config)
  const idempotencyKeyTtlMs = config.idempotency?.idempotencyKeyTtlMs ?? 600_000

  // ── 5b. Sandbox override (per-service limits; merged with global defaults in server-factory) ──
  const sandboxOverride: SandboxOverride = {
    ...(config.sandbox?.memoryLimitMb !== undefined && { memoryLimitMb: config.sandbox.memoryLimitMb }),
    ...(config.sandbox?.executeTimeoutMs !== undefined && { executeTimeoutMs: config.sandbox.executeTimeoutMs }),
    ...(config.sandbox?.searchTimeoutMs !== undefined && { searchTimeoutMs: config.sandbox.searchTimeoutMs }),
    ...(config.sandbox?.maxApiCalls !== undefined && { maxApiCalls: config.sandbox.maxApiCalls }),
    ...(config.sandbox?.maxConcurrentCalls !== undefined && { maxConcurrentCalls: config.sandbox.maxConcurrentCalls })
  }

  // ── 5c. Spec source config ──────────────────────────────────────────────
  const specSource = {
    type: (config.spec?.source ?? 'file') as 'file' | 'url' | 'url-with-fallback',
    url: config.spec?.url,
  }

  // ── 5d. Service-level refresh (applies to both spec and skills) ───────
  const serviceRefreshIntervalMs = config.serviceRefreshIntervalMs ?? 0
  const serviceRefreshTimeoutMs = config.serviceRefreshTimeoutMs ?? 10_000

  // ── 6. Scan skills directory ─────────────────────────────────────────────
  const skills = scanSkills(serviceDir)

  // ── 7. Build description ─────────────────────────────────────────────────
  const description = config.description
    ?? (spec as Record<string, unknown> & { info?: { description?: string } }).info?.description
    ?? `Service: ${name}`

  return {
    name,
    description,
    serviceDir,
    spec,
    specPath,
    specSource,
    serviceRefreshIntervalMs,
    serviceRefreshTimeoutMs,
    skills,
    apiConfig,
    auth,
    circuitBreaker,
    permissionGuard,
    idempotencyBackend,
    idempotencyKeyTtlMs,
    sandboxOverride
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function findSpecFile(dir: string): string | undefined {
  for (const candidate of ['spec.json', 'spec.yaml', 'spec.yml']) {
    const p = join(dir, candidate)
    if (existsSync(p)) return p
  }
  return undefined
}

export function scanSkills(serviceDir: string): SkillMetadata[] {
  const skillsDir = join(serviceDir, 'skills')
  if (!existsSync(skillsDir) || !statSync(skillsDir).isDirectory()) return []

  return readdirSync(skillsDir)
    .filter(f => extname(f) === '.md')
    .map(filename => {
      const raw = readFileSync(join(skillsDir, filename), 'utf-8')
      const parsed = matter(raw)
      const id = basename(filename, '.md')
      const titleMatch = parsed.content.match(/^#\s+(.+)$/m)
      const title = (parsed.data['title'] as string | undefined)?.trim()
        ?? titleMatch?.[1]?.trim()
        ?? id.replace(/-/g, ' ')
      const tags: string[] = Array.isArray(parsed.data['tags'])
        ? (parsed.data['tags'] as unknown[]).map(String)
        : []
      return { id, filename, title, tags, content: raw }
    })
}

function resolveApiConfig(
  config: ServiceConfig,
  spec: OpenAPISpec,
  serviceName: string,
  logger: Logger
): ServiceDefinition['apiConfig'] {
  if (config.api) {
    const { tls } = config.api
    return {
      protocol: config.api.protocol ?? 'http',
      host: config.api.host ?? 'localhost',
      port: config.api.port ?? 8080,
      basePath: config.api.basePath ?? '',
      requestTimeoutMs: config.api.requestTimeoutMs ?? 30_000,
      maxRetries: config.api.maxRetries ?? 1,
      ...(tls?.certPath && tls?.keyPath && tls?.caPath ? { tls } : {})
    }
  }

  // Fall back to the spec's servers field
  const servers = (spec as Record<string, unknown> & { servers?: Array<{ url: string }> }).servers
  if (servers?.[0]?.url) {
    const rawUrl = servers[0].url
    try {
      const url = new URL(rawUrl)
      const defaultPort = url.protocol === 'https:' ? 443 : 8080
      return {
        protocol: url.protocol === 'https:' ? 'https' : 'http',
        host: url.hostname,
        port: Number(url.port) || defaultPort,
        basePath: url.pathname === '/' ? '' : url.pathname,
        requestTimeoutMs: 30_000,
        maxRetries: 1
      }
    } catch (err) {
      // Silently falling through to localhost:8080 would route real traffic
      // to a phantom backend. Fail the scan so the service is skipped.
      throw new Error(
        `service "${serviceName}": spec.servers[0].url (${rawUrl}) is not a valid URL ` +
        `and no config.api override is set — refusing to default to localhost:8080. ` +
        `Fix config.api or spec.servers[0].url. Cause: ${errorMessage(err)}`
      )
    }
  }

  logger.warn(
    { service: serviceName },
    'No config.api and no spec.servers[0].url — defaulting to http://localhost:8080'
  )
  return { protocol: 'http', host: 'localhost', port: 8080, basePath: '', requestTimeoutMs: 30_000, maxRetries: 1 }
}

function resolveIdempotencyBackend(config: ServiceConfig): IdempotencyBackendConfig {
  const idem = config.idempotency
  if (!idem) return { type: STORE_TYPE.NOOP }

  switch (idem.type) {
    case STORE_TYPE.NOOP:      return { type: STORE_TYPE.NOOP }
    case STORE_TYPE.IN_MEMORY: return { type: STORE_TYPE.IN_MEMORY }
    case STORE_TYPE.MEMCACHE:
      return {
        type: STORE_TYPE.MEMCACHE,
        host: idem['host'] as string ?? 'localhost',
        port: idem['port'] as number ?? 11211,
        kvTimeoutMs: idem['kvTimeoutMs'] as number ?? 2000
      }
    case STORE_TYPE.COUCHBASE:
      return {
        type: STORE_TYPE.COUCHBASE,
        host: idem['host'] as string ?? 'localhost',
        port: idem['port'] as number ?? 8093,
        bucket: idem['bucket'] as string ?? 'default',
        username: idem['username'] as string ?? '',
        password: idem['password'] as string ?? '',
        kvTimeoutMs: idem['kvTimeoutMs'] as number ?? 3000
      }
  }
}
