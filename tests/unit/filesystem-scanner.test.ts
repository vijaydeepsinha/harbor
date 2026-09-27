// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { scanServicesDirectory, scanSkills } from '../../src/runtime/registry/filesystem-scanner.js'
import { buildIdempotencyStrategy } from '../../src/wiring/strategy-builders.js'
import { buildServiceResources } from '../../src/runtime/gateway/service-resources-factory.js'
import { InMemoryTokenCache } from '../../src/adapters/auth/strategies/in-memory-token-cache.strategy.js'
import { globalConfig } from './code-mode-harness.js'

const silent = pino({ level: 'silent' })
const SPEC = 'openapi: 3.0.0\ninfo: { title: t, version: "1" }\npaths: {}\n'

function service(root: string, name: string, config: Record<string, unknown> = {}, spec = SPEC): string {
  const dir = join(root, name)
  mkdirSync(join(dir, 'skills'), { recursive: true })
  writeFileSync(join(dir, 'spec.yaml'), spec)
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    api: { protocol: 'http', host: 'localhost', port: 3001 }, auth: { type: 'static-token', token: 'demo-token-123' }, ...config
  }))
  return dir
}

describe('scanServicesDirectory — one bad entry never takes the others down', () => {
  let root: string | undefined
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined })

  it('skips a dangling symlink in the services directory instead of failing boot', async () => {
    root = mkdtempSync(join(tmpdir(), 'harbor-svcs-'))
    service(root, 'good')
    symlinkSync(join(root, 'gone'), join(root, 'dangling'))
    const scanned = await scanServicesDirectory(root, silent)
    expect(scanned.map(s => s.name)).toEqual(['good'])
  })

  it('skips only the skill file that cannot be parsed; keeps the rest and reads a numeric title', async () => {
    root = mkdtempSync(join(tmpdir(), 'harbor-svcs-'))
    const dir = service(root, 'svc')
    writeFileSync(join(dir, 'skills', 'good.md'), '---\ntitle: 2026 plan\n---\n# Heading\nbody')
    writeFileSync(join(dir, 'skills', 'numeric.md'), '---\ntitle: 42\n---\nbody')
    writeFileSync(join(dir, 'skills', 'broken.md'), '---\ntitle: [unclosed\n---\nbody')
    mkdirSync(join(dir, 'skills', 'folder.md'))
    const skills = scanSkills(dir, silent)
    expect(skills.map(s => [s.id, s.title]).sort()).toEqual([['good', '2026 plan'], ['numeric', '42']])
    const [scanned] = await scanServicesDirectory(root, silent)
    expect(scanned?.skills).toHaveLength(2)
  })

  it('a servers URL without a port means the scheme\'s port (80 for http)', async () => {
    root = mkdtempSync(join(tmpdir(), 'harbor-svcs-'))
    const dir = join(root, 'svc')
    mkdirSync(dir)
    writeFileSync(join(dir, 'spec.yaml'), `${SPEC}servers:\n  - url: http://api.example.com/v1\n`)
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ auth: { type: 'static-token', token: 'demo-token-123' } }))
    const [scanned] = await scanServicesDirectory(root, silent)
    expect(scanned?.apiConfig).toMatchObject({ protocol: 'http', host: 'api.example.com', port: 80, basePath: '/v1' })
  })

  it('refuses a refresh interval setInterval would clamp to 1 ms', async () => {
    root = mkdtempSync(join(tmpdir(), 'harbor-svcs-'))
    for (const [name, ms] of [['negative', -1], ['tiny', 5], ['huge', 2_592_000_000], ['fraction', 1500.5]] as const) {
      service(root, name, { serviceRefreshIntervalMs: ms })
    }
    service(root, 'off', { serviceRefreshIntervalMs: 0 })
    service(root, 'minute', { serviceRefreshIntervalMs: 60_000 })
    const scanned = await scanServicesDirectory(root, silent)
    expect(scanned.map(s => s.name).sort()).toEqual(['minute', 'off'])
  })

  it('an unknown idempotency type is refused, not silently turned into no deduplication', async () => {
    root = mkdtempSync(join(tmpdir(), 'harbor-svcs-'))
    service(root, 'svc', { idempotency: { type: 'postgres' } })
    const [scanned] = await scanServicesDirectory(root, silent)
    expect(scanned?.idempotencyBackend).toEqual({ type: 'postgres' })
    expect(() => buildIdempotencyStrategy(scanned!.idempotencyBackend)).toThrow('Unknown idempotency type: "postgres"')
  })

  it('a service without an idempotency block gets the gateway default (IDEMPOTENCY_TYPE); its own block wins', async () => {
    root = mkdtempSync(join(tmpdir(), 'harbor-svcs-'))
    service(root, 'inherits')
    service(root, 'own', { idempotency: { type: 'noop' } })
    const scanned = await scanServicesDirectory(root, silent)
    const cache = new InMemoryTokenCache(60_000)
    try {
      const config = { ...globalConfig, defaultIdempotency: { type: 'in-memory' as const } }
      const byName = Object.fromEntries(await Promise.all(scanned.map(async svc => {
        const r = await buildServiceResources(svc, config, cache)
        r.refresher.stop()
        return [svc.name, r.idempotencyStrategyName]
      })))
      expect(byName).toEqual({ inherits: 'in-memory', own: 'noop' })
    } finally {
      cache.destroy()
    }
  })
})
