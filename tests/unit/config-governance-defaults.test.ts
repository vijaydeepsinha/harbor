// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { validateGlobalConfig } from '../../src/core/config/config.js'
import { GOVERNANCE_DECISION } from '../../src/core/constants.js'

describe('governance configuration defaults', () => {
  const KEYS = ['GOVERNANCE_DEFAULT_DECISION', 'GOVERNANCE_RULES_SOURCE', 'GOVERNANCE_RULES_URL', 'GOVERNANCE_RULES_URL_TIMEOUT_MS', 'GOVERNANCE_RULES_REFRESH_SEC', 'EXECUTION_CODE_RETENTION', 'EXECUTION_RETENTION_SEC',
    'EXECUTION_STORE_TYPE', 'EXECUTION_STORE_MEMCACHE_HOST', 'EXECUTION_STORE_MEMCACHE_PORT', 'EXECUTION_STORE_MEMCACHE_TIMEOUT_MS',
    'EXECUTION_STORE_MEMCACHE_KEY_PREFIX', 'EXECUTION_STORE_MEMCACHE_LOCK_TTL_SEC', 'HARBOR_SERVER_ID'] as const
  let saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]))
    for (const k of KEYS) delete process.env[k]
  })
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('defaults GOVERNANCE_DEFAULT_DECISION to DENY (fail closed where governance applies)', () => {
    delete process.env['GOVERNANCE_DEFAULT_DECISION']
    expect(validateGlobalConfig().codeMode.governance.defaultDecision).toBe(GOVERNANCE_DECISION.DENY)
  })

  it('rules load once from the directory by default', () => {
    expect(validateGlobalConfig().codeMode.governance).toMatchObject({ rulesSource: 'dir', rulesRefreshSec: 0, rulesUrlTimeoutMs: 5000 })
    expect(validateGlobalConfig().codeMode.governance.rulesUrl).toBeUndefined()
  })

  it('reads the url source and the refresh interval', () => {
    process.env['GOVERNANCE_RULES_SOURCE'] = 'url'
    process.env['GOVERNANCE_RULES_URL'] = 'https://rules.example/set.yaml'
    process.env['GOVERNANCE_RULES_URL_TIMEOUT_MS'] = '2500'
    process.env['GOVERNANCE_RULES_REFRESH_SEC'] = '30'
    expect(validateGlobalConfig().codeMode.governance).toMatchObject({
      rulesSource: 'url', rulesUrl: 'https://rules.example/set.yaml', rulesUrlTimeoutMs: 2500, rulesRefreshSec: 30
    })
  })

  it('drops a terminal execution\'s code by default; KEEP keeps it', () => {
    expect(validateGlobalConfig().codeMode.retention).toMatchObject({ code: 'DROP' })
    process.env['EXECUTION_CODE_RETENTION'] = 'KEEP'
    expect(validateGlobalConfig().codeMode.retention).toMatchObject({ code: 'KEEP' })
  })

  it('keeps finished executions for a day by default; 0 keeps them for good', () => {
    expect(validateGlobalConfig().codeMode.retention).toMatchObject({ executionSec: 86_400 })
    process.env['EXECUTION_RETENTION_SEC'] = '0'
    expect(validateGlobalConfig().codeMode.retention).toMatchObject({ executionSec: 0 })
  })

  it('EXECUTION_STORE_TYPE=memcache reads its connection like the token cache, plus key prefix and lock TTL', () => {
    process.env['EXECUTION_STORE_TYPE'] = 'memcache'
    process.env['EXECUTION_STORE_MEMCACHE_HOST'] = 'memcache.internal'
    process.env['EXECUTION_STORE_MEMCACHE_PORT'] = '11211'
    expect(validateGlobalConfig().codeMode.store).toEqual({ type: 'memcache', host: 'memcache.internal', port: 11211, kvTimeoutMs: 2000 })
    process.env['EXECUTION_STORE_MEMCACHE_TIMEOUT_MS'] = '500'
    process.env['EXECUTION_STORE_MEMCACHE_KEY_PREFIX'] = 'prod:harbor:'
    process.env['EXECUTION_STORE_MEMCACHE_LOCK_TTL_SEC'] = '900'
    expect(validateGlobalConfig().codeMode.store).toEqual({
      type: 'memcache', host: 'memcache.internal', port: 11211, kvTimeoutMs: 500, keyPrefix: 'prod:harbor:', lockTtlSec: 900
    })
  })

  it('EXECUTION_STORE_TYPE=memcache without its host and port stops the gateway', () => {
    process.env['EXECUTION_STORE_TYPE'] = 'memcache'
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`) }) as never)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => validateGlobalConfig()).toThrow('exit 1')
      expect(String(error.mock.calls[0]?.[0])).toContain('EXECUTION_STORE_MEMCACHE_HOST')
    } finally {
      exit.mockRestore()
      error.mockRestore()
    }
  })

  it('HARBOR_SERVER_ID stamps outbound calls — HARBOR_GATEWAY by default; a value unsafe in a header stops the gateway', () => {
    expect(validateGlobalConfig().observability.serverId).toBe('HARBOR_GATEWAY')
    process.env['HARBOR_SERVER_ID'] = 'harbor-eu-1'
    expect(validateGlobalConfig().observability.serverId).toBe('harbor-eu-1')
    process.env['HARBOR_SERVER_ID'] = 'bad\r\nvalue'
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`) }) as never)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => validateGlobalConfig()).toThrow('exit 1')
      expect(String(error.mock.calls[0]?.[0])).toContain('HARBOR_SERVER_ID')
    } finally {
      exit.mockRestore()
      error.mockRestore()
    }
  })

  it('honours an explicit value', () => {
    process.env['GOVERNANCE_DEFAULT_DECISION'] = GOVERNANCE_DECISION.ALLOW
    expect(validateGlobalConfig().codeMode.governance.defaultDecision).toBe(GOVERNANCE_DECISION.ALLOW)
  })
})
