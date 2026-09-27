// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { DirectoryRuleSourceStrategy } from '../../spi/governance/strategies/directory-rule-source.strategy.js'
import { UrlRuleSourceStrategy } from '../../spi/governance/strategies/url-rule-source.strategy.js'
import type { GovernanceRuleDocument, GovernanceRuleSource } from '../../spi/governance/rule-source.js'
import { parseRuleDocuments, GovernanceRuleLoadError } from '../../runtime/governance/rule-loader.js'
import { GovernanceRuleStore } from '../../runtime/governance/rule-store.js'
import { GovernanceRuleRefresher } from '../../runtime/governance/rule-refresher.js'
import { buildGovernanceRuleSource, registerGovernanceRuleSourceBackend } from '../../wiring/strategy-builders.js'
import { buildCodeModeRuntime } from '../../runtime/execution/code-mode-runtime.js'
import type { CodeModeConfig } from '../../core/types/config.types.js'
import type { Logger } from '../../core/types/logger.types.js'
import { GOVERNANCE_DECISION } from '../../core/constants.js'

const silent = pino({ level: 'silent' }) as unknown as Logger
const ruleYaml = (name: string, type = 'DENY') => `name: ${name}\nmatch: { service: s }\naction: { type: ${type} }\n`

/** A logger that remembers what was logged at error level. */
function recordingLogger() {
  const errors: string[] = []
  const logger = { info() {}, warn() {}, debug() {}, error(_o: unknown, msg: string) { errors.push(msg) } } as unknown as Logger
  return { logger, errors }
}

/** A source whose documents a test can change or break. */
function mutableSource(initial: GovernanceRuleDocument[]) {
  let docs = initial
  let failure: Error | undefined
  const source: GovernanceRuleSource = {
    name: 'test:mutable',
    async load() { if (failure) throw failure; return docs }
  }
  return {
    source,
    set(next: GovernanceRuleDocument[]) { docs = next; failure = undefined },
    fail(err: Error) { failure = err }
  }
}
const doc = (name: string, text: string): GovernanceRuleDocument => ({ name, format: 'yaml', text })

describe('Governance Rule sources', () => {
  let dir: string
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('dir: rule files directly in the directory, in file-name order; other files and sub-directories are skipped', async () => {
    dir = mkdtempSync(join(tmpdir(), 'harbor-src-'))
    writeFileSync(join(dir, '20-b.yaml'), ruleYaml('b'))
    writeFileSync(join(dir, '10-a.json'), JSON.stringify({ name: 'a', match: { service: 's' }, action: { type: 'ALLOW' } }))
    writeFileSync(join(dir, 'notes.md'), 'ignored')
    mkdirSync(join(dir, 'examples'))
    writeFileSync(join(dir, 'examples', 'x.yaml'), ruleYaml('x'))
    const source = new DirectoryRuleSourceStrategy(dir)
    expect(source.name).toBe(`dir:${dir}`)
    const docs = await source.load()
    expect(docs.map(d => [d.name, d.format])).toEqual([['10-a.json', 'json'], ['20-b.yaml', 'yaml']])
    expect(await new DirectoryRuleSourceStrategy(join(dir, 'missing')).load()).toEqual([])
  })

  describe('url', () => {
    let server: Server
    let base: string
    const routes: Record<string, { status?: number; type?: string; body: string; delayMs?: number }> = {}
    beforeAll(async () => {
      server = createServer((req, res) => {
        const route = routes[(req.url ?? '').split('?')[0] ?? '']
        if (!route) { res.statusCode = 404; res.end('nope'); return }
        setTimeout(() => {
          res.statusCode = route.status ?? 200
          if (route.type) res.setHeader('content-type', route.type)
          res.end(route.body)
        }, route.delayMs ?? 0)
      })
      await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    })
    afterAll(async () => { await new Promise(r => server.close(r)) })

    it('fetches one document; YAML unless the response (or the URL) says JSON; the name carries no secret', async () => {
      routes['/rules.yaml'] = { body: `rules:\n  - ${ruleYaml('a').trim().split('\n').join('\n    ')}\n` }
      routes['/rules'] = { type: 'application/json', body: JSON.stringify([{ name: 'j', match: { service: 's' }, action: { type: 'ALLOW' } }]) }
      const secretUrl = base.replace('http://', 'http://user:pw@') + '/rules.yaml?token=abc'
      const yamlSource = new UrlRuleSourceStrategy(secretUrl, 2000)
      expect(yamlSource.name).toBe(`url:${base}/rules.yaml`)
      const [yamlDoc] = await yamlSource.load()
      expect(yamlDoc).toMatchObject({ name: `${base}/rules.yaml`, format: 'yaml' })
      expect(parseRuleDocuments([yamlDoc!]).map(l => l.rule.name)).toEqual(['a'])
      const [jsonDoc] = await new UrlRuleSourceStrategy(`${base}/rules`, 2000).load()
      expect(jsonDoc?.format).toBe('json')
      expect(parseRuleDocuments([jsonDoc!])[0]?.source).toBe(`${base}/rules`)
    })

    it('anything but a 2xx, or a timeout, throws — the caller keeps what it has', async () => {
      routes['/down'] = { status: 503, body: 'maintenance' }
      routes['/slow'] = { body: ruleYaml('slow'), delayMs: 500 }
      await expect(new UrlRuleSourceStrategy(`${base}/down`, 2000).load()).rejects.toThrow()
      await expect(new UrlRuleSourceStrategy(`${base}/missing`, 2000).load()).rejects.toThrow()
      await expect(new UrlRuleSourceStrategy(`${base}/slow`, 100).load()).rejects.toThrow(/timeout/i)
    })
  })

  it('a rule set spans documents: one hash per document; a name used twice anywhere is an error', () => {
    const loaded = parseRuleDocuments([doc('a.yaml', ruleYaml('a')), doc('b.yaml', ruleYaml('b'))])
    expect(loaded.map(l => [l.rule.name, l.source])).toEqual([['a', 'a.yaml'], ['b', 'b.yaml']])
    expect(loaded[0]?.contentHash).not.toBe(loaded[1]?.contentHash)
    expect(() => parseRuleDocuments([doc('a.yaml', ruleYaml('dup')), doc('b.yaml', ruleYaml('dup'))]))
      .toThrow(new GovernanceRuleLoadError('b.yaml: duplicate rule name "dup" (also in a.yaml)', 'b.yaml'))
  })

  describe('refresh keeps the last valid rule set', () => {
    it('swaps a changed set, keeps an unchanged one, and keeps the previous set when the source is broken or unreachable', async () => {
      const { source, set, fail } = mutableSource([doc('a.yaml', ruleYaml('a'))])
      const store = new GovernanceRuleStore()
      store.swap(parseRuleDocuments(await source.load()))
      const { logger, errors } = recordingLogger()
      const refresher = new GovernanceRuleRefresher(source, store, 60, logger)
      const names = () => store.getRules().map(r => r.rule.name)

      expect(await refresher.refresh()).toBe('unchanged')
      set([doc('a.yaml', ruleYaml('a', 'ALLOW')), doc('b.yaml', ruleYaml('b'))])
      expect(await refresher.refresh()).toBe('swapped')
      expect(names()).toEqual(['a', 'b'])
      expect(store.getRules()[0]?.rule.action.type).toBe('ALLOW')

      set([doc('a.yaml', 'name: a\nmatch: {}\naction: { type: DENY }\n')]) // invalid: empty match
      expect(await refresher.refresh()).toBe('failed')
      fail(new Error('connect ECONNREFUSED'))
      expect(await refresher.refresh()).toBe('failed')
      expect(names()).toEqual(['a', 'b'])
      expect(errors).toEqual([
        'Governance rule refresh failed — keeping the last valid rule set',
        'Governance rule refresh failed — keeping the last valid rule set'
      ])
    })

    it('never runs two refreshes at once', async () => {
      let release!: () => void
      const source: GovernanceRuleSource = {
        name: 'test:slow',
        load: () => new Promise(resolve => { release = () => resolve([doc('a.yaml', ruleYaml('a'))]) })
      }
      const refresher = new GovernanceRuleRefresher(source, new GovernanceRuleStore(), 60, silent)
      const first = refresher.refresh()
      expect(await refresher.refresh()).toBe('skipped')
      release()
      expect(await first).toBe('swapped')
    })

    it('runs on its interval once started, never with interval 0, and stops', async () => {
      vi.useFakeTimers()
      try {
        const load = vi.fn(async () => [doc('a.yaml', ruleYaml('a'))])
        const off = new GovernanceRuleRefresher({ name: 'x', load }, new GovernanceRuleStore(), 0, silent)
        off.start()
        await vi.advanceTimersByTimeAsync(60_000)
        expect(load).not.toHaveBeenCalled()

        const on = new GovernanceRuleRefresher({ name: 'x', load }, new GovernanceRuleStore(), 30, silent)
        on.start()
        await vi.advanceTimersByTimeAsync(61_000)
        expect(load).toHaveBeenCalledTimes(2)
        on.stop()
        await vi.advanceTimersByTimeAsync(60_000)
        expect(load).toHaveBeenCalledTimes(2)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('wiring', () => {
    const governance = (extra: Partial<CodeModeConfig['governance']>): CodeModeConfig['governance'] =>
      ({ rulesDir: '/nonexistent', defaultDecision: GOVERNANCE_DECISION.DENY, approvalTtlSec: 600, ...extra })

    it('builds dir by default, url when configured (URL required), a registered type, and refuses an unknown one', () => {
      expect(buildGovernanceRuleSource(governance({})).name).toBe('dir:/nonexistent')
      expect(buildGovernanceRuleSource(governance({ rulesSource: 'url', rulesUrl: 'https://rules.example/set.yaml' })).name).toBe('url:https://rules.example/set.yaml')
      expect(() => buildGovernanceRuleSource(governance({ rulesSource: 'url' }))).toThrow(/GOVERNANCE_RULES_URL is required/)
      expect(() => buildGovernanceRuleSource(governance({ rulesSource: 's3' }))).toThrow(/Unknown governance rule source: "s3"/)
      registerGovernanceRuleSourceBackend('test-registered', () => ({ name: 'registered', load: async () => [] }))
      expect(buildGovernanceRuleSource(governance({ rulesSource: 'test-registered' })).name).toBe('registered')
    })

    it('boot fails closed on an unreadable or invalid first load; then the configured refresh keeps rules current', async () => {
      dir = mkdtempSync(join(tmpdir(), 'harbor-src-'))
      writeFileSync(join(dir, 'bad.yaml'), 'name: bad\nmatch: { service: s }\naction: { type: MAYBE }\n')
      const config = (g: Partial<CodeModeConfig['governance']>): CodeModeConfig => ({ store: { type: 'in-memory' }, governance: governance(g) })
      await expect(buildCodeModeRuntime(config({ rulesDir: dir }), silent)).rejects.toThrow(GovernanceRuleLoadError)
      await expect(buildCodeModeRuntime(config({ rulesSource: 'url', rulesUrl: 'http://127.0.0.1:1/rules.yaml', rulesUrlTimeoutMs: 500 }), silent)).rejects.toThrow()

      const { source, set } = mutableSource([doc('a.yaml', ruleYaml('a'))])
      registerGovernanceRuleSourceBackend('test-mutable', () => source)
      vi.useFakeTimers()
      try {
        const runtime = await buildCodeModeRuntime(config({ rulesSource: 'test-mutable', rulesRefreshSec: 5 }), silent)
        expect(runtime.rules.getRules().map(r => r.rule.name)).toEqual(['a'])
        set([doc('a.yaml', ruleYaml('a')), doc('b.yaml', ruleYaml('b'))])
        await vi.advanceTimersByTimeAsync(5_000)
        expect(runtime.rules.getRules().map(r => r.rule.name)).toEqual(['a', 'b'])
        await runtime.shutdown()
        set([doc('c.yaml', ruleYaml('c'))])
        await vi.advanceTimersByTimeAsync(10_000)
        expect(runtime.rules.getRules().map(r => r.rule.name)).toEqual(['a', 'b']) // stopped with the runtime
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
