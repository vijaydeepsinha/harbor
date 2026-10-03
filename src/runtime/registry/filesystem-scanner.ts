// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs'
import {basename, extname, join, resolve} from 'node:path'
import matter from 'gray-matter'
import SwaggerParser from '@apidevtools/swagger-parser'
import type {OpenAPISpec} from '../../core/types/spec.types.js'
import type {AuthStrategy} from '../../spi/auth/auth-strategy.js'
import type {CircuitBreakerStrategy} from '../../spi/resilience/circuit-breaker.js'
import type {
    IdempotencyBackendConfig,
    GovernanceRuleSourceConfig,
    SandboxOverride,
    ServiceAuthConfig,
    ServiceCircuitBreakerConfig
} from '../../core/types/config.types.js'
import type {PermissionGuard} from '../../spi/permissions/permission-guard.js'
import type {Logger} from '../observability/logger.js'
import {GOVERNANCE_RULE_SOURCE_TYPE, STORE_TYPE} from '../../core/constants.js'
import {errorMessage} from '../../core/utils/errors.js'
import {resolveAuth, resolveCircuitBreaker, resolvePermissionGuard} from '../../wiring/service-wiring.js'

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
    governance?: {
        rulesSource?: string
        rulesDir?: string
        rulesUrl?: string
        rulesUrlTimeoutMs?: number
        rulesRefreshSec?: number
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
    governance: GovernanceRuleSourceConfig
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
    /** From config.json's `idempotency` block; absent ⇒ the gateway default (IDEMPOTENCY_TYPE). */
    idempotencyBackend?: IdempotencyBackendConfig
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
        logger.warn({servicesDir}, 'Services directory does not exist — no services will be loaded')
        return []
    }

    const entries = readdirSync(servicesDir)
    const scannedServices: ServiceDefinition[] = []

    for (const entry of entries) {
        const serviceDir = join(servicesDir, entry)
        try {
            // Inside the try: a dangling symlink (or an entry removed mid-scan)
            // makes statSync throw, and one bad entry must not stop the gateway.
            if (!statSync(serviceDir).isDirectory()) continue
        } catch (err) {
            logger.warn({
                service: entry,
                error: errorMessage(err)
            }, `Cannot read "${entry}" in the services directory — skipping`)
            continue
        }

        try {
            const service = await scanSingleService(serviceDir, entry, logger)
            if (!service) continue
            scannedServices.push(service)
            logger.info(
                {service: entry, skills: service.skills.length, specPath: service.specPath},
                `Scanned service "${entry}"`
            )
        } catch (err) {
            const msg = errorMessage(err)
            logger.error({service: entry, error: msg}, `Failed to scan service "${entry}" — skipping`)
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
        logger.info({service: name}, 'No config.json found — using defaults')
    }

    // ── 2. Check enabled flag — skip before expensive spec parse ─────────────
    if (config.enabled === false) {
        logger.info({service: name}, `Service "${name}" is disabled — skipping`)
        return null
    }

    const governance = resolveGovernanceConfig(config.governance, serviceDir, name)

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
    const permissionGuard = resolvePermissionGuard()
    const idempotencyBackend = resolveIdempotencyBackend(config)
    const idempotencyKeyTtlMs = config.idempotency?.idempotencyKeyTtlMs ?? 600_000

    // ── 5b. Sandbox override (per-service limits; merged with global defaults in server-factory) ──
    const sandboxOverride: SandboxOverride = {
        ...(config.sandbox?.memoryLimitMb !== undefined && {memoryLimitMb: config.sandbox.memoryLimitMb}),
        ...(config.sandbox?.executeTimeoutMs !== undefined && {executeTimeoutMs: config.sandbox.executeTimeoutMs}),
        ...(config.sandbox?.searchTimeoutMs !== undefined && {searchTimeoutMs: config.sandbox.searchTimeoutMs}),
        ...(config.sandbox?.maxApiCalls !== undefined && {maxApiCalls: config.sandbox.maxApiCalls}),
        ...(config.sandbox?.maxConcurrentCalls !== undefined && {maxConcurrentCalls: config.sandbox.maxConcurrentCalls})
    }

    // ── 5c. Spec source config ──────────────────────────────────────────────
    const specSource = {
        type: (config.spec?.source ?? 'file') as 'file' | 'url' | 'url-with-fallback',
        url: config.spec?.url,
    }

    // ── 5d. Service-level refresh (applies to both spec and skills) ───────
    const serviceRefreshIntervalMs = config.serviceRefreshIntervalMs ?? 0
    const serviceRefreshTimeoutMs = config.serviceRefreshTimeoutMs ?? 10_000
    // setInterval clamps a negative, NaN or > 2^31-1 delay to 1 ms: a typo would
    // re-read the spec and every skill file a thousand times a second.
    if (serviceRefreshIntervalMs !== 0 && !(Number.isInteger(serviceRefreshIntervalMs) && serviceRefreshIntervalMs >= MIN_REFRESH_INTERVAL_MS && serviceRefreshIntervalMs <= MAX_TIMER_MS)) {
        throw new Error(`service "${name}": serviceRefreshIntervalMs must be 0 (off) or an integer from ${MIN_REFRESH_INTERVAL_MS} to ${MAX_TIMER_MS}, got ${String(serviceRefreshIntervalMs)}`)
    }
    if (!(Number.isInteger(serviceRefreshTimeoutMs) && serviceRefreshTimeoutMs > 0 && serviceRefreshTimeoutMs <= MAX_TIMER_MS)) {
        throw new Error(`service "${name}": serviceRefreshTimeoutMs must be a positive integer ≤ ${MAX_TIMER_MS}, got ${String(serviceRefreshTimeoutMs)}`)
    }

    // ── 6. Scan skills directory ─────────────────────────────────────────────
    const skills = scanSkills(serviceDir, logger)

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
        governance,
        skills,
        apiConfig,
        auth,
        circuitBreaker,
        permissionGuard,
        ...(idempotencyBackend !== undefined ? {idempotencyBackend} : {}),
        idempotencyKeyTtlMs,
        sandboxOverride
    }

    function resolveGovernanceConfig(
        config: ServiceConfig['governance'],
        serviceDir: string,
        serviceName: string
    ): GovernanceRuleSourceConfig {
        const rulesSource = config?.rulesSource ?? GOVERNANCE_RULE_SOURCE_TYPE.FILE
        const rulesRefreshSec = config?.rulesRefreshSec ?? 0
        const rulesUrlTimeoutMs = config?.rulesUrlTimeoutMs ?? 5000
        const rulesUrl = config?.rulesUrl
        if (!Number.isInteger(rulesRefreshSec) || rulesRefreshSec < 0 || rulesRefreshSec > Math.floor(MAX_TIMER_MS / 1000)) {
            throw new Error(`service "${serviceName}": governance.rulesRefreshSec must be 0 or an integer from 1 to ${Math.floor(MAX_TIMER_MS / 1000)}, got ${String(rulesRefreshSec)}`)
        }
        if (!Number.isInteger(rulesUrlTimeoutMs) || rulesUrlTimeoutMs <= 0 || rulesUrlTimeoutMs > MAX_TIMER_MS) {
            throw new Error(`service "${serviceName}": governance.rulesUrlTimeoutMs must be a positive integer ≤ ${MAX_TIMER_MS}, got ${String(rulesUrlTimeoutMs)}`)
        }
        if (rulesSource === 'url' && !rulesUrl) {
            throw new Error(`service "${serviceName}": governance.rulesUrl is required when governance.rulesSource is "url"`)
        }
        if (rulesSource === 'url') {
            try {
                new URL(rulesUrl!)
            } catch {
                throw new Error(`service "${serviceName}": governance.rulesUrl must be a valid URL`)
            }
        }
        return {
            rulesDir: resolve(serviceDir, config?.rulesDir ?? 'governance/rules'),
            rulesSource,
            ...(rulesUrl !== undefined ? {rulesUrl} : {}),
            rulesUrlTimeoutMs,
            rulesRefreshSec
        }
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Shortest spec/skill refresh interval a service may ask for. */
const MIN_REFRESH_INTERVAL_MS = 1_000
/** Longest delay setInterval/setTimeout honour; beyond it Node fires after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647

function findSpecFile(dir: string): string | undefined {
    for (const candidate of ['spec.json', 'spec.yaml', 'spec.yml']) {
        const p = join(dir, candidate)
        if (existsSync(p)) return p
    }
    return undefined
}

/**
 * Every readable `*.md` file in `skills/`. A file that cannot be read or
 * parsed (bad frontmatter, a directory or a dangling editor symlink named
 * `*.md`) is skipped with a warning — it must not take the whole service,
 * and every other skill, offline.
 */
export function scanSkills(serviceDir: string, logger?: Logger): SkillMetadata[] {
    const skillsDir = join(serviceDir, 'skills')
    if (!existsSync(skillsDir) || !statSync(skillsDir).isDirectory()) return []

    const skills: SkillMetadata[] = []
    for (const filename of readdirSync(skillsDir).filter(f => extname(f) === '.md')) {
        try {
            const file = join(skillsDir, filename)
            if (!statSync(file).isFile()) continue
            const raw = readFileSync(file, 'utf-8')
            // An options object turns off gray-matter's parse cache: a file that
            // failed once must fail again (the cache returned a blank parse for it).
            const parsed = matter(raw, {})
            const id = basename(filename, '.md')
            const titleMatch = parsed.content.match(/^#\s+(.+)$/m)
            const frontmatterTitle = parsed.data['title']
            const title = (typeof frontmatterTitle === 'string' || typeof frontmatterTitle === 'number' ? String(frontmatterTitle).trim() : undefined)
                || titleMatch?.[1]?.trim()
                || id.replace(/-/g, ' ')
            const tags: string[] = Array.isArray(parsed.data['tags'])
                ? (parsed.data['tags'] as unknown[]).map(String)
                : []
            skills.push({id, filename, title, tags, content: raw})
        } catch (err) {
            logger?.warn({
                skillsDir,
                file: filename,
                error: errorMessage(err)
            }, `Skipping skill "${filename}" — it cannot be read or parsed`)
        }
    }
    return skills
}

function resolveApiConfig(
    config: ServiceConfig,
    spec: OpenAPISpec,
    serviceName: string,
    logger: Logger
): ServiceDefinition['apiConfig'] {
    if (config.api) {
        const {tls} = config.api
        return {
            protocol: config.api.protocol ?? 'http',
            host: config.api.host ?? 'localhost',
            port: config.api.port ?? 8080,
            basePath: config.api.basePath ?? '',
            requestTimeoutMs: config.api.requestTimeoutMs ?? 30_000,
            maxRetries: config.api.maxRetries ?? 1,
            ...(tls?.certPath && tls?.keyPath && tls?.caPath ? {tls} : {})
        }
    }

    // Fall back to the spec's servers field
    const servers = (spec as Record<string, unknown> & { servers?: Array<{ url: string }> }).servers
    if (servers?.[0]?.url) {
        const rawUrl = servers[0].url
        try {
            const url = new URL(rawUrl)
            // A URL without a port means the scheme's port — 80 for http, not 8080.
            const defaultPort = url.protocol === 'https:' ? 443 : 80
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
        {service: serviceName},
        'No config.api and no spec.servers[0].url — defaulting to http://localhost:8080'
    )
    return {protocol: 'http', host: 'localhost', port: 8080, basePath: '', requestTimeoutMs: 30_000, maxRetries: 1}
}

function resolveIdempotencyBackend(config: ServiceConfig): IdempotencyBackendConfig | undefined {
    const idem = config.idempotency
    if (!idem) return undefined

    switch (idem.type) {
        case STORE_TYPE.NOOP:
            return {type: STORE_TYPE.NOOP}
        case STORE_TYPE.IN_MEMORY:
            return {type: STORE_TYPE.IN_MEMORY}
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
        default:
            // A registered backend (registerIdempotencyBackend) or a typo: hand the
            // block to the builder, which uses the registered factory or refuses the
            // service. Returning nothing here silently meant "no deduplication".
            return idem as unknown as IdempotencyBackendConfig
    }
}
