// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { validateGlobalConfig } from '../../core/config/config.js'
import { GOVERNANCE_DECISION } from '../../core/constants.js'

describe('governance configuration defaults', () => {
  const KEYS = ['GOVERNANCE_DEFAULT_DECISION', 'GOVERNANCE_RULES_SOURCE', 'GOVERNANCE_RULES_URL', 'GOVERNANCE_RULES_URL_TIMEOUT_MS', 'GOVERNANCE_RULES_REFRESH_SEC'] as const
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

  it('honours an explicit value', () => {
    process.env['GOVERNANCE_DEFAULT_DECISION'] = GOVERNANCE_DECISION.ALLOW
    expect(validateGlobalConfig().codeMode.governance.defaultDecision).toBe(GOVERNANCE_DECISION.ALLOW)
  })
})
